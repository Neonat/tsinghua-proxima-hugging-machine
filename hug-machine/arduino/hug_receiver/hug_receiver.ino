// 拥抱接收器 / Hug Receiver — 太空站机器人 (space-station robot)
//
// 在原 pipeline.ino 基础上增加"参数化拥抱回放"协议：地球端录制的拥抱
// (squeeze + wrap_reach 时间序列) 由电脑经串口逐帧发送，机器人手臂据此
// 复现拥抱的力度与节奏。原有的自动 "hug" 指令与 LED 表情保持不变。
//
// Adds a parametric hug-playback protocol on top of the original sketch.
// The computer streams one strength byte per frame (~10 Hz); the arms press
// past the point of body contact in proportion to it. All the "how squeeze
// maps to force" logic lives on the computer (Python) so it can be tuned
// WITHOUT reflashing — the Arduino stays dumb and safe.
//
// 串口协议 / Serial protocol (9600 baud, newline-terminated):
//   hug        原有自动拥抱 (unchanged autonomous hug)
//   play       开始回放：先寻找接触点，再进入受控挤压 (seek contact, then stream)
//   s<0-255>   设置当前挤压强度，如 s0 / s128 / s255 (set squeeze strength)
//   end        结束回放，松开手臂 (release and finish)
//   stop       紧急松开 (emergency open, any state)
// 机器人回传状态行 / robot -> computer status lines: >SEEK >STREAM >DONE >STOP
//   以及 >CONTACT <arm> <angle> (每臂触到人体时) for debugging / UI.

#include <Servo.h>
#include <Adafruit_NeoPixel.h>

// #define DEBUG

// ---------- 预设常量定义 ----------
#define MATRIX_SIZE 8
#define PANEL_COUNT 2
#define BRIGHTNESS  20

const int ARM_PINs[2] = {9, 10};
const int TOUCH_PINs[2] = {2, 3};
const int LED_PIN = 6;
const bool aemServoReversed[2] = {false, false};

// ---------- 启用的手臂 (which arms are driven) ----------
// 只启用一个手臂可将舵机峰值电流减半，更容易仅靠 USB 供电（无需外接电源）。
// Driving ONE arm roughly halves peak servo current — often lets you run on
// USB power alone with no extra hardware. {arm0 = pin 9, arm1 = pin 10}.
// Once you have proper servo power, set both to true.
const bool armEnabled[2] = {true, false};
const int PANEL_SIZE = (MATRIX_SIZE * MATRIX_SIZE);
const int LED_COUNT = (PANEL_SIZE * PANEL_COUNT);

// ---------- 回放安全常量 (SAFETY — tune these on the bench) ----------
// 触到人体后，最多再往里压多少度。这是最重要的安全上限：越大越紧。
// Max degrees the arms may press PAST first body contact. THE key safety
// limit — larger = tighter squeeze. Start small, increase carefully.
#define PRESS_MARGIN     30
// 寻找接触时的最大闭合角 (若触摸传感器一直未触发时的兜底上限)。
// Cap on closing angle while seeking contact (fallback if a touch sensor
// never fires — e.g. nobody there / arm misses the body).
#define APPROACH_MAX     165
// 寻找接触的闭合速度 (度/秒)，越慢越安全，也越省电流。Contact-seek speed,
// deg/sec — slower also means lower peak current (gentler on USB power).
#define APPROACH_SPEED   50
// 挤压阶段手臂的最大变化速度 (度/秒)，限制突变，平滑、安全、省电流。
// Max servo slew during the squeeze phase, deg/sec — smooths sudden jumps
// and keeps the current draw down.
#define SLEW_RATE        120
// 回放中超过这么久没收到帧就自动松开 (毫秒)，防止卡死在挤压状态。
// Auto-release if no frame arrives for this long, ms — stall watchdog.
#define FRAME_TIMEOUT    800
// 寻找接触的总超时 (毫秒)。Max time to seek contact before giving up.
#define SEEK_TIMEOUT     4500
// 绝对安全角上限，任何情况下手臂都不会超过它。Hard ceiling, never exceeded.
#define MAX_SAFE_ANGLE   180

enum State { IDLE, HUGGING, HUG_WAIT, PLAY_SEEK, PLAY_STREAM, PLAY_RELEASE };

// ----------- 对象定义 -------------
Servo ArmServo[2];
Adafruit_NeoPixel strip(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);
uint32_t frameBuffer[LED_COUNT];

// ---------- 表情图案常量定义 ----------
const uint32_t EYE_COLOR = strip.Color(255, 255, 255);

const byte eye_up[8]       = {B00000000,B00001000,B00010100,B00100010,B00000000,B00000000,B00000000,B00000000};
const byte eye_straight[8] = {B00000000,B00001000,B00001000,B00001000,B00001000,B00001000,B00000000,B00000000};
const byte eye_dash[8]     = {B00000000,B00000000,B00000000,B01111110,B00000000,B00000000,B00000000,B00000000};
const byte eye_wink[8]     = {B00000000,B00010000,B00001000,B00000100,B00001000,B00010000,B00000000,B00000000};
const byte eye_center[8]   = {B00000000,B00000010,B00000010,B00000010,B00000010,B00000010,B00000000,B00000000};
const byte eye_edge[8]     = {B00000000,B00100000,B00100000,B00100000,B00100000,B00100000,B00000000,B00000000};
// ♥ 眼 (回放中的"被爱"表情) — heart, shown while receiving a hug
const byte eye_heart[8]    = {B00000000,B00100100,B01111110,B01111110,B00111100,B00011000,B00000000,B00000000};

// ---------- 舵机部分 ----------
void servo_Setup() {
  // 只 attach 启用的舵机 — 未启用的完全不驱动, 不耗电流。
  // Only attach enabled servos; a disabled one is never driven at all.
  for (int i = 0; i < 2; i++)
    if (armEnabled[i]) ArmServo[i].attach(ARM_PINs[i], 500, 2500);
  both_arm_to_angle(0);   // 初始张开
}

inline void arm_to_angle(int arm, int angle) {
  if (!armEnabled[arm]) return;
  if (aemServoReversed[arm]) angle = 180 - angle;
  ArmServo[arm].write(angle);
}

inline void both_arm_to_angle(int angle) {
  arm_to_angle(0, angle);
  arm_to_angle(1, angle);
}

// ---------- LED点阵屏部分 ----------
void LEDscreen_setup() {
  strip.begin();
  strip.setBrightness(BRIGHTNESS);
  clearBuffer();
  showBuffer();
}

inline void clearBuffer() {
  for (int i = 0; i < LED_COUNT; i++) frameBuffer[i] = strip.Color(0, 0, 0);
}

inline void showBuffer() {
  for (int i = 0; i < LED_COUNT; i++) strip.setPixelColor(i, frameBuffer[i]);
  strip.show();
}

int xyToIndex(uint8_t panel, uint8_t x, uint8_t y) {
  if (panel) x = MATRIX_SIZE - x - 1;
  if (x & 1) y = MATRIX_SIZE - y - 1;
  return panel * PANEL_SIZE + x * MATRIX_SIZE + y;
}

void drawPatternOnPanel(uint8_t panel, const byte pattern[MATRIX_SIZE], uint32_t color) {
  for (uint8_t y = 0; y < MATRIX_SIZE; y++)
    for (uint8_t x = 0; x < MATRIX_SIZE; x++)
      if ((pattern[y] >> (7 - x)) & 1)
        frameBuffer[xyToIndex(panel, x, y)] = color;
}

void drawPatternOnPanelWithOffset(uint8_t panel, const byte pattern[8], uint32_t color, int yOffset) {
  for (int y = 0; y < 8; y++) {
    int dstY = y + yOffset;
    if (dstY < 0 || dstY >= 8) continue;
    for (int x = 0; x < 8; x++)
      if ((pattern[y] >> (7 - x)) & 1)
        frameBuffer[xyToIndex(panel, x, dstY)] = color;
  }
}

// ---------- 触摸传感器部分 ----------
inline void Touch_Setup() {
  pinMode(TOUCH_PINs[0], INPUT_PULLUP);
  pinMode(TOUCH_PINs[1], INPUT_PULLUP);
}

inline bool isTouching(int arm) { return !digitalRead(TOUCH_PINs[arm]); }

// ---------- 全局状态 ----------
State currentState = IDLE;
unsigned long stateStartTime = 0, elapsed = 0, now = 0, lastLoop = 0;

// 环抱动作变量 (原自动 hug)
unsigned long hugStartTime = 0;
bool armTouched[2] = {false, false};
const unsigned long HUG_DURATION = 3000;

// 参数化回放变量 (parametric playback)
float armCur[2] = {0, 0};        // 当前命令角度 (float, 便于限速) current commanded angle
int   contactAngle[2] = {0, 0};  // 每臂接触点角度 captured contact angle
bool  contactFound[2] = {false, false};
int   targetStrength = 0;        // 最新强度 0..255 latest strength byte
unsigned long lastFrameTime = 0; // 上次收到帧的时间 watchdog

// 待机表情变量
bool expressionPlaying = false;
int  expressionType = 0;
unsigned long nextExpressionTime = 0, expressionStartTime = 0;
int  winkEye = 0;
bool scanLeftToRight = true;

// 串口输入缓冲 (跨 loop 持久, 逐行解析) persistent line buffer
String inputBuffer = "";

// ---------- 显示表情 ----------
inline void playDefault() {
  clearBuffer();
  drawPatternOnPanel(0, eye_up, EYE_COLOR);
  drawPatternOnPanel(1, eye_up, EYE_COLOR);
  showBuffer();
}

inline void playHeart() {  // 回放时的表情 — hug-receiving face
  clearBuffer();
  drawPatternOnPanel(0, eye_heart, strip.Color(255, 40, 90));
  drawPatternOnPanel(1, eye_heart, strip.Color(255, 40, 90));
  showBuffer();
}

inline void playBlink() {
  int step = elapsed / 125;
  const byte* seq[4] = {eye_straight, eye_dash, eye_straight, eye_dash};
  clearBuffer();
  drawPatternOnPanel(0, seq[step], EYE_COLOR);
  drawPatternOnPanel(1, seq[step], EYE_COLOR);
  showBuffer();
}

inline void playScan() {
  bool step = scanLeftToRight ^ (elapsed < 250);
  const byte* seq_left[2] = {eye_center, eye_edge};
  const byte* seq_right[2] = {eye_edge, eye_center};
  clearBuffer();
  drawPatternOnPanel(0, seq_left[step], EYE_COLOR);
  drawPatternOnPanel(1, seq_right[step], EYE_COLOR);
  showBuffer();
}

inline void playWink() {
  int step = elapsed / 125;
  const byte* seq[4] = {eye_straight, eye_wink, eye_straight, eye_up};
  clearBuffer();
  drawPatternOnPanel(winkEye,    seq[step], EYE_COLOR);
  drawPatternOnPanel(winkEye^1,  eye_up,    EYE_COLOR);
  showBuffer();
}

inline void playNod() {
  int phase = elapsed % 500 / 125;
  const int offset_seq[4] = {-1, 1, 3, 4};
  clearBuffer();
  drawPatternOnPanelWithOffset(0, eye_up, EYE_COLOR, offset_seq[phase]);
  drawPatternOnPanelWithOffset(1, eye_up, EYE_COLOR, offset_seq[phase]);
  showBuffer();
}

// ---------- 回放辅助 (playback helpers) ----------
inline void writeArm(int i) {
  int a = (int)(armCur[i] + 0.5f);
  a = constrain(a, 0, MAX_SAFE_ANGLE);
  arm_to_angle(i, a);
}

// 朝目标角以限速方式移动 slew armCur[i] toward target, respecting SLEW_RATE
inline void slewArm(int i, float target, float degStep) {
  float d = target - armCur[i];
  if (d >  degStep) d =  degStep;
  if (d < -degStep) d = -degStep;
  armCur[i] += d;
  writeArm(i);
}

void startPlayback() {
  currentState = PLAY_SEEK;
  stateStartTime = now;
  armCur[0] = armCur[1] = 0;
  contactFound[0] = contactFound[1] = false;
  contactAngle[0] = contactAngle[1] = APPROACH_MAX;
  targetStrength = 0;
  both_arm_to_angle(0);
  expressionPlaying = false;
  playHeart();
  Serial.println(F(">SEEK"));
}

void releasePlayback(const __FlashStringHelper* tag) {
  currentState = PLAY_RELEASE;
  stateStartTime = now;
  Serial.println(tag);
}

// ---------- 逻辑处理函数 ----------
// 逐字节读取串口, 按行解析命令 (persistent buffer across loops)
void checkSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      inputBuffer.trim();
      if (inputBuffer.length()) handleCommand(inputBuffer);
      inputBuffer = "";
    } else {
      inputBuffer += c;
      if (inputBuffer.length() > 16) inputBuffer = "";  // 防溢出 guard
    }
  }
}

void handleCommand(const String& cmd) {
  // 紧急松开 — 任何状态 (emergency open, any state)
  if (cmd == "stop") {
    both_arm_to_angle(0);
    armCur[0] = armCur[1] = 0;
    currentState = IDLE;
    stateStartTime = now;
    nextExpressionTime = now + random(3000, 8000);
    playDefault();
    Serial.println(F(">STOP"));
    return;
  }

  // 强度帧 s<0-255> — 仅回放中有效 (strength frame; valid during playback)
  if (cmd.length() >= 2 && cmd[0] == 's') {
    int v = cmd.substring(1).toInt();
    targetStrength = constrain(v, 0, 255);
    if (currentState == PLAY_SEEK || currentState == PLAY_STREAM)
      lastFrameTime = now;   // 收到帧, 喂狗 feed the watchdog
    return;
  }

  if (cmd == "play" && (currentState == IDLE)) { startPlayback(); return; }

  if (cmd == "end") {
    if (currentState == PLAY_SEEK || currentState == PLAY_STREAM)
      releasePlayback(F(">DONE"));
    return;
  }

  // 原有自动拥抱 (unchanged autonomous hug)
  if (cmd == "hug" && currentState == IDLE) {
    currentState = HUGGING;
    hugStartTime = now;
    armTouched[0] = armTouched[1] = false;
    both_arm_to_angle(0);
    expressionPlaying = false;
    playDefault();
#ifdef DEBUG
    Serial.println(F("Hugging."));
#endif
  }
}

inline void selectIdle() {
  int r = random(3);
  if (r == 0)      { expressionType = 1; }
  else if (r == 1) { expressionType = 2; scanLeftToRight = random(2); }
  else             { expressionType = 3; winkEye = random(2); }
  expressionPlaying = true;
  expressionStartTime = now;
}

inline void playIdle() {
  elapsed = now - expressionStartTime;
  if (elapsed >= 500) {
    expressionPlaying = false;
    nextExpressionTime = now + random(3000, 8000);
    playDefault();
    return;
  }
  switch (expressionType) {
    case 1: playBlink(); return;
    case 2: playScan();  return;
    case 3: playWink();  return;
  }
}

void handleIdle() {
  if (!expressionPlaying) {
    if (now >= nextExpressionTime) selectIdle();
    else delay(5);
  } else {
    playIdle();
  }
}

void handleHugging() {
  elapsed = now - hugStartTime;
  if (elapsed >= HUG_DURATION) {
    both_arm_to_angle(0);
    playDefault();
    currentState = IDLE;
    stateStartTime = now;
    expressionPlaying = false;
    nextExpressionTime = now + random(3000, 8000);
    return;
  }
  bool allTouched = true;
  for (int i = 0; i < 2; i++) {
    if (!armEnabled[i]) continue;          // 跳过未启用的手臂 skip disabled arm
    if (!armTouched[i]) {
      arm_to_angle(i, 180 * elapsed / HUG_DURATION);
      if (isTouching(i)) armTouched[i] = true;
      else allTouched = false;
    }
  }
  if (allTouched) { currentState = HUG_WAIT; stateStartTime = now; }
}

void handleHugWait() {
  elapsed = now - stateStartTime;
  if (elapsed >= 1000) {
    both_arm_to_angle(0);
    currentState = IDLE;
    stateStartTime = now;
    expressionPlaying = false;
    nextExpressionTime = now + random(3000, 8000);
    playDefault();
  } else {
    playNod();
  }
}

// 寻找接触点: 双臂缓慢闭合, 触到即记录该臂角度并停住
// Seek contact: close both arms slowly; when a touch sensor fires, freeze
// that arm and remember its angle as the zero-force point.
void handlePlaySeek(float degStep) {
  bool bothDone = true;
  for (int i = 0; i < 2; i++) {
    if (!armEnabled[i]) continue;          // 跳过未启用的手臂 skip disabled arm
    if (contactFound[i]) continue;
    if (isTouching(i)) {
      contactFound[i] = true;
      contactAngle[i] = (int)(armCur[i] + 0.5f);
      Serial.print(F(">CONTACT ")); Serial.print(i);
      Serial.print(' '); Serial.println(contactAngle[i]);
    } else {
      armCur[i] += degStep;
      if (armCur[i] >= APPROACH_MAX) { armCur[i] = APPROACH_MAX; contactAngle[i] = APPROACH_MAX; }
      else bothDone = false;
      writeArm(i);
    }
  }
  if (bothDone || (now - stateStartTime) >= SEEK_TIMEOUT) {
    currentState = PLAY_STREAM;
    stateStartTime = now;
    lastFrameTime = now;
    Serial.println(F(">STREAM"));
  }
}

// 挤压阶段: 每臂目标 = 接触角 + 强度*压力余量, 限速平滑跟随
// Squeeze phase: each arm targets contact + strength·PRESS_MARGIN, slewed.
void handlePlayStream(float degStep) {
  if (now - lastFrameTime > FRAME_TIMEOUT) { releasePlayback(F(">DONE")); return; }
  float frac = targetStrength / 255.0f;
  for (int i = 0; i < 2; i++) {
    if (!armEnabled[i]) continue;
    int base = contactFound[i] ? contactAngle[i] : APPROACH_MAX;
    float target = base + frac * PRESS_MARGIN;
    if (target > MAX_SAFE_ANGLE) target = MAX_SAFE_ANGLE;
    slewArm(i, target, degStep);
  }
  playHeart();
}

// 松开阶段: 双臂限速回到张开, 然后回到空闲
void handlePlayRelease(float degStep) {
  for (int i = 0; i < 2; i++)
    if (armEnabled[i]) slewArm(i, 0, degStep);
  if (armCur[0] <= 0.5f && armCur[1] <= 0.5f) {
    both_arm_to_angle(0);
    currentState = IDLE;
    stateStartTime = now;
    expressionPlaying = false;
    nextExpressionTime = now + random(3000, 8000);
    playDefault();
  }
}

// ---------- 初始化和主循环 ----------
void setup() {
  Serial.begin(9600);
  randomSeed(analogRead(0));
  servo_Setup();
  LEDscreen_setup();
  Touch_Setup();
  currentState = IDLE;
  stateStartTime = millis();
  lastLoop = millis();
  nextExpressionTime = millis() + random(3000, 8000);
  playDefault();
  Serial.println(F(">READY"));
}

void loop() {
  checkSerial();
  now = millis();
  float dt = (now - lastLoop) / 1000.0f;   // 秒 seconds since last loop
  lastLoop = now;
  float seekStep = APPROACH_SPEED * dt;
  float slewStep = SLEW_RATE * dt;

  switch (currentState) {
    case IDLE:         handleIdle();               break;
    case HUGGING:      handleHugging();            break;
    case HUG_WAIT:     handleHugWait();            break;
    case PLAY_SEEK:    handlePlaySeek(seekStep);   break;
    case PLAY_STREAM:  handlePlayStream(slewStep); break;
    case PLAY_RELEASE: handlePlayRelease(slewStep); break;
  }
}
