#!/usr/bin/env python3
"""Standalone Samford top-10 MLB win predictor.

The web app also has this logic as its fifth rules engine. This script keeps
the article-ranked rule set easy to test with a plain dictionary or JSON file.
"""

import argparse
import json
from pathlib import Path


ARTICLE_RANKING = [
    ("RD", "RD", 10, "higher"),
    ("ERA", "ERA", 9, "lower"),
    ("FIP", "FIP", 8, "lower"),
    ("LOB_pct", "LOB%", 7, "higher"),
    ("pWAR", "pWAR", 6, "higher"),
    ("WHIP", "WHIP", 5, "lower"),
    ("H9", "H/9", 4, "lower"),
    ("BAA", "BAA", 3, "lower"),
    ("oWAR", "oWAR", 2, "higher"),
    ("SV", "SV", 1, "higher"),
]

WEIGHTS = {stat: weight for stat, _label, weight, _direction in ARTICLE_RANKING}
LOWER_IS_BETTER = {stat for stat, _label, _weight, direction in ARTICLE_RANKING if direction == "lower"}
MAX_STAT_EDGE = 15

STAT_SCALES = {
    "RD": 243,        # roughly 1.5 runs/game over 162 games
    "ERA": 1.4,
    "FIP": 1.2,
    "LOB_pct": 0.07,
    "pWAR": 17.8,    # roughly 0.11 WAR/game over 162 games
    "WHIP": 0.30,
    "H9": 2.0,
    "BAA": 0.045,
    "oWAR": 17.8,
    "SV": 19.4,      # roughly 0.12 saves/game over 162 games
}

STAT_LABELS = {stat: label for stat, label, _weight, _direction in ARTICLE_RANKING}

# Aliases make real FanGraphs/CSV-style column names easy to swap in.
STAT_ALIASES = {
    "RD": ["RD", "run_differential", "Run Differential"],
    "ERA": ["ERA"],
    "FIP": ["FIP"],
    "LOB_pct": ["LOB_pct", "LOB%", "LOB_pct_", "Left On Base Percentage"],
    "pWAR": ["pWAR", "pitchingWAR", "Pitching WAR"],
    "WHIP": ["WHIP"],
    "H9": ["H9", "H/9", "Hits/9"],
    "BAA": ["BAA", "AVG", "Batting Average Against"],
    "oWAR": ["oWAR", "offensiveWAR", "Offensive WAR"],
    "SV": ["SV", "Saves"],
}

SAMPLE_TEAMS = {
    "Team A": {
        "RD": 87,
        "ERA": 3.45,
        "FIP": 3.60,
        "LOB_pct": 0.762,
        "pWAR": 22.4,
        "WHIP": 1.21,
        "H9": 8.1,
        "BAA": 0.238,
        "oWAR": 18.7,
        "SV": 41,
    },
    "Team B": {
        "RD": 54,
        "ERA": 3.91,
        "FIP": 4.05,
        "LOB_pct": 0.731,
        "pWAR": 17.1,
        "WHIP": 1.34,
        "H9": 8.8,
        "BAA": 0.251,
        "oWAR": 20.2,
        "SV": 33,
    },
}


def validate_article_alignment():
    """Keep the standalone rules engine pinned to the Samford article order."""
    expected = [
        ("RD", 10, "higher"),
        ("ERA", 9, "lower"),
        ("FIP", 8, "lower"),
        ("LOB_pct", 7, "higher"),
        ("pWAR", 6, "higher"),
        ("WHIP", 5, "lower"),
        ("H9", 4, "lower"),
        ("BAA", 3, "lower"),
        ("oWAR", 2, "higher"),
        ("SV", 1, "higher"),
    ]
    actual = [(stat, WEIGHTS[stat], "lower" if stat in LOWER_IS_BETTER else "higher") for stat in WEIGHTS]
    if actual != expected:
        raise RuntimeError("Samford article ranking mismatch in standalone predictor.")


validate_article_alignment()


def read_stat(stats, stat_key):
    """Read a stat using the canonical name or a supported data-source alias."""
    for key in STAT_ALIASES[stat_key]:
        if key in stats:
            return float(stats[key])
    raise KeyError(f"Missing required stat {stat_key}")


def normalize_pair(team_value, opponent_value, stat, lower_is_better=False):
    """Calibrate the two-team edge around 50 instead of winner-take-all."""
    if team_value == opponent_value:
        return 0.5
    signed_diff = opponent_value - team_value if lower_is_better else team_value - opponent_value
    edge = max(-MAX_STAT_EDGE, min(MAX_STAT_EDGE, (signed_diff / STAT_SCALES[stat]) * MAX_STAT_EDGE))
    return (50 + edge) / 100


def format_value(stat, value):
    if stat == "LOB_pct":
        return f"{value * 100:.1f}%"
    if stat == "BAA":
        return f"{value:.3f}".lstrip("0")
    if stat in {"ERA", "FIP", "WHIP", "H9"}:
        return f"{value:.2f}"
    if stat in {"pWAR", "oWAR"}:
        return f"{value:.1f}"
    return f"{value:.0f}"


def score_teams(teams):
    """Return raw stat rows and final 0-100 composite scores."""
    names = list(teams)
    if len(names) != 2:
        raise ValueError("Input must contain exactly two teams.")

    total_weight = sum(WEIGHTS.values())
    scores = {name: 0.0 for name in names}
    rows = []

    for stat, weight in WEIGHTS.items():
        values = {name: read_stat(teams[name], stat) for name in names}
        normalized = {
            name: normalize_pair(values[name], values[names[1 if name == names[0] else 0]], stat, stat in LOWER_IS_BETTER)
            for name in names
        }

        for name in names:
            scores[name] += normalized[name] * weight

        if normalized[names[0]] == normalized[names[1]]:
            advantage = "Tie"
        else:
            advantage = names[0] if normalized[names[0]] > normalized[names[1]] else names[1]

        rows.append({
            "stat": stat,
            "values": values,
            "advantage": advantage,
            "weight": weight,
            "contrib": {name: normalized[name] * weight / total_weight * 100 for name in names},
        })

    final_scores = {name: value / total_weight * 100 for name, value in scores.items()}
    return names, rows, final_scores


def print_report(teams, season=None):
    names, rows, scores = score_teams(teams)
    winner = max(scores, key=scores.get)
    margin = abs(scores[names[0]] - scores[names[1]])

    print("=" * 76)
    title = "MLB WIN PREDICTOR - STAT COMPARISON"
    if season:
        title += f" ({season})"
    print(title.center(76))
    print("=" * 76)
    print(
        f"{'Stat':<10} | {names[0]:>10} | {names[1]:>10} | "
        f"{'Advantage':<18} | {'Wt':>2} | {'A Pts':>5} | {'B Pts':>5}"
    )
    print("-" * 76)
    for row in rows:
        stat = row["stat"]
        print(
            f"{STAT_LABELS[stat]:<10} | "
            f"{format_value(stat, row['values'][names[0]]):>10} | "
            f"{format_value(stat, row['values'][names[1]]):>10} | "
            f"{row['advantage']:<18} | "
            f"{row['weight']:>2} | "
            f"{row['contrib'][names[0]]:>5.1f} | "
            f"{row['contrib'][names[1]]:>5.1f}"
        )
    print("-" * 76)
    print(f"COMPOSITE SCORE:  {names[0]}: {scores[names[0]]:.1f}   {names[1]}: {scores[names[1]]:.1f}")
    print(f"PREDICTED WINNER: {winner} (Confidence margin: {margin:.0f}%)")
    print("=" * 76)


def load_json(path):
    with Path(path).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def main():
    parser = argparse.ArgumentParser(description="Samford top-10 MLB win predictor.")
    parser.add_argument("--json", dest="json_path", help="Path to a JSON file containing exactly two teams.")
    parser.add_argument("--season", help="Optional season label for the output.")
    args = parser.parse_args()

    teams = load_json(args.json_path) if args.json_path else SAMPLE_TEAMS
    print_report(teams, season=args.season)


if __name__ == "__main__":
    main()
