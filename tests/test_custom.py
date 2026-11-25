"""The home page's own-key checker: key parsing, choosing the right key page and set, and marks."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from omr import custom as C  # noqa: E402


def ans(s):
    return [{"q": i + 1, "answer": "" if a == "0" else a, "status": "blank" if a == "0" else "ok"} for i, a in enumerate(s)]


def test_parse_and_grade():
    assert C.parse_key("1 A\n2 c\n3 B/D\n4 X", 4)[1]["Key"] == {1: "1", 2: "3", 3: "24", 4: "X"}
    assert C.parse_key("Q A1 B1\n1 3 2\n2 4 1", 2)[1] == {"A1": {1: "3", 2: "4"}, "B1": {1: "2", 2: "1"}}
    g = C.grade(ans("3105"), {1: "3", 2: "4", 3: "2", 4: "1"},
                {"correct": 1, "wrong": -0.25, "blank": -0.25, "multiple": -0.25, "skipped": 0, "five": "5", "per_q": {2: 2}})
    assert (g["score"], g["max_score"]) == (0.5, 5.0), g   # +1, -0.25 wrong, -0.25 blank, 0 for option 5


def test_choose_key_page_and_set():
    a = "1234123412341234123412341234"
    pages = [{"label": "p2", "keys": {"A1": {i + 1: "4" for i in range(28)}, "B1": {i + 1: "1" for i in range(28)}}},
             {"label": "p4", "keys": {"A1": {i + 1: c for i, c in enumerate(a)}, "B1": {i + 1: "2" for i in range(28)}}}]
    assert C.choose_key(pages, ans(a), "A1")[:2] == (1, "A1")          # the set on the sheet, the page that fits
    assert C.choose_key(pages, ans(a), "")[:2] == (1, "A1")            # no set read: the clear best match
    try:
        C.choose_key(pages, ans("0" * 28), "")
        raise AssertionError("should ask for the set")
    except ValueError as e:
        assert "Choose" in str(e)


if __name__ == "__main__":
    test_parse_and_grade()
    test_choose_key_page_and_set()
    print("ok")
