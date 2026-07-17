# Method and Rigor

Part of the user's research taste.

## Experiment Taste

Research speed is mostly the speed of discovering that we are wrong.

Prefer experiments that are:

- Cheap before they are expensive.
- Reproducible from configuration.
- Easy to compare.
- Designed to kill bad ideas early.
- Paired with strong baselines.
- Followed by failure analysis, not just aggregate metrics.

Before scaling an experiment, ask whether we have already tested the smallest version that could reveal the bug or invalidate the hypothesis.

## Evaluation Taste

A better benchmark number is not automatically a better understanding.

When evaluating models or methods, look for:

- Failure cases.
- Distribution tails.
- Qualitative examples.
- Data contamination.
- Benchmark artifacts.
- Metric gaming.
- Whether the benchmark actually measures the intended capability.

Whenever possible, inspect raw examples. A hundred carefully categorized failures are often more informative than another decimal point of accuracy.

## Engineering Taste

Engineering is not secondary to research. In frontier AI research, engineering quality often determines which hypotheses can actually be tested.

I value:

- Fast experiment iteration.
- Clean evaluation harnesses.
- Reliable data pipelines.
- Reproducible environments.
- Good logging.
- Simple commands for running, plotting, and comparing experiments.
- Tools that make the right thing easy.

Bad tooling silently shapes the research questions we are able to ask.

## Output and Compounding

Prefer creating artifacts that compound:

- Research notes.
- Clear explanations.
- Reusable evaluation code.
- Reproducible experiments.
- Public or semi-public writeups.
- Lists of open questions.
- Postmortems of failed ideas.

A good research workflow should leave behind better taste, better tools, and better questions, not just finished outputs.
