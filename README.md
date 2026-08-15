# demo-storefront synthetic evaluator

Run `npm install`, set `LD_EVALUATION_SDK_KEY`, then use `npm run evaluate -- --cohort checkout-beta --cluster prod-eu-west-01` for a ten-evaluation one-shot batch or `npm run traffic -- --profile production` for cumulative traffic. One-shot count can be changed with `--evaluations`; `--cluster` selects a fixed synthetic cluster. Only demo-orders Production accepts `--evaluations-per-hour 10..100000` and `--context-pool-size 1..10000`. Stop traffic with Ctrl+C so pending events flush.
