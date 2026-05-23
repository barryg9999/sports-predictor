# Sports Scorecard

This is a local web app for scoring sports matchups by model. It currently supports MLB, with room to add more pro sports later.

## What is included

- `server.js`: local web server and live MLB data/scoring endpoint
- `mlb.html`: scorecard page
- `mlb.js`: date picker, scoring table, and game detail rendering
- `styles.css`: page styling
- `package.json`: project metadata and start command
- Backtest and calibration panel for completed MLB date ranges
- Prediction snapshot storage for freezing picks before first pitch
- FanDuel/DraftKings odds comparison for moneyline, run line, totals, tie markets, and model edge

## Requirements

- Node.js 18 or newer
- Internet access, because the app reads live public data from MLB Stats API
- Optional odds access through The Odds API. Set `ODDS_API_KEY` or `THE_ODDS_API_KEY` before starting the app.

## Run It

From this folder:

```sh
npm start
```

Then open:

```text
http://127.0.0.1:4173/mlb.html
```

If port `4173` is already in use, another copy of the app is probably already running. Open the URL above, or stop the old terminal process with `Ctrl+C` and run `npm start` again.

Click any game row to view the selected matchup's six displayed values for each team: composite score, starter score, team-strength score, bullpen score, lineup score, and home-field score.

For completed games, the table and selected-game detail show the actual winner and final score from MLB's schedule feed.

If either team has no probable starter listed, the model does not project a winner. The table shows `No projection`, the winner/score columns show `N/A`, and the game detail explains which team is missing a listed starter.

Use the sport and model selectors to switch analysis models. The app currently supports MLB only, with two MLB models:

- `MLB Core 5`: the original five-metric model.
- `MLB Expanded 10`: a ten-metric model using starting-pitcher K-BB%, starting-pitcher FIP, lineup handedness split offense, Pythagorean team strength, bullpen workload, bullpen skill, lineup quality, starter contact allowed, park fit, and defense proxy.

Use **Odds Comparison** to load FanDuel and DraftKings odds from a server-side odds provider. The panel compares:

- Moneyline prices and no-vig market probability
- Run line prices and listed points
- Total prices and listed points
- Returned 3-way/tie moneyline outcomes, when a book provides them
- Push notes for whole-number run lines or totals
- Model edge versus the no-vig moneyline market

Full-game MLB moneylines are normally two-way. Tie prices appear only when the provider/book returns a 3-way or tie market. Run lines and totals can push when the listed point is a whole number.

Use **Backtest & Calibration** to run completed slates through either model or both models. The backtest shows:

- Overall accuracy
- Right/wrong counts
- Accuracy by confidence bucket: tight, lean, solid, strong
- No-pick threshold summaries for all picks, margin 3+, margin 7+, and margin 12+
- The strongest tested picks in the selected date range

Use **Prediction Snapshots** before games start to save the model, pick, margin, confidence bucket, component scores, and game status at capture time. Snapshot backtests count only picks captured before the scheduled first pitch, then compare those frozen picks with final MLB scores later.

Backtests are limited to 10 days at a time. Use the `Saved snapshots` source for real tracking. Use `Historical estimate` only for quick research on dates where no pregame snapshot was saved, because it rebuilds the old slate from the current public MLB API response.

## Notes

The model calculates:

```text
Score = (SP_score x 0.30) + (PythW%_score x 0.25) + (Bullpen_score x 0.20) + (wRC+_score x 0.18) + (HFA_score x 0.07)
```

MLB public data does not directly expose confirmed projected lineup wRC+ for every future game, so the app uses a transparent proxy: the top nine hitters by plate appearances in the opposing starter's handedness split, scaled from estimated wOBA against league wOBA.

If a probable starter has no usable season innings or no starter is listed, the app uses current league-average FIP from the same MLB data pull and labels that fallback in the selected-game detail.

The Expanded 10 model uses transparent public-feed proxies where the MLB Stats API does not provide the exact advanced metric directly, including xFIP/SIERA, xwOBA/xSLG, xERA/xwOBA allowed, bullpen availability, and OAA/DRS.

## Future Changes

When you want to modify this app later, refer to this folder as the `sports-scorecard` project. For example:

```text
Open /Users/barry/Desktop/sports-scorecard and add another MLB model.
```
