import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("hug_storage", Path(__file__).parents[1] / "storage.py")
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class LeaderboardTests(unittest.TestCase):
    def test_tied_scores_have_the_same_rank_in_results_and_leaderboard(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(storage, "PROFILE_DIR", root / "profiles"):
                store = storage.Storage(root / "leaderboard.db")
                try:
                    for index, overall in enumerate([8.0, 8.0, 6.0, 9.0]):
                        result = store.save_hug({
                            "metadata": {
                                "hugger_name": f"Hugger {index}",
                                "timestamp": f"2026-07-10T12:00:0{index}+00:00",
                                "duration_ms": 10000,
                            },
                            "scoring": {
                                "strength": 8.0, "style": 8.0, "coverage": 8.0,
                                "warmth": 9.0, "overall": overall, "hug_type": "body-hug",
                            },
                        })
                        row = next(row for row in store.leaderboard() if row["id"] == result["id"])
                        self.assertEqual(row["rank"], result["rank"])
                    rows = store.leaderboard()
                    self.assertEqual([row["rank"] for row in rows], [1, 2, 2, 4])
                    self.assertEqual([row["id"] for row in rows], [4, 1, 2, 3])
                    self.assertEqual(store.leaderboard(limit=2), rows[:2])
                    for row in rows:
                        self.assertEqual(row["rank"], store.rank_of(row["overall"]))
                finally:
                    store.close()


if __name__ == "__main__":
    unittest.main()
