# Customer-support datasets

The current inference benchmark uses
[`DianJin/DianJin-CSC-Data`](https://huggingface.co/datasets/DianJin/DianJin-CSC-Data),
an MIT-licensed Chinese customer-support conversation dataset with about 13.1k
training rows.

Generate the reproducible 1K/2K serving benchmark slice with:

```bash
python3 scripts/prepare_dianjin_csc.py
```

Generated files are intentionally ignored by Git:

- `data/raw/dianjin_csc_train.parquet`: original Hugging Face parquet.
- `data/cleaned/dianjin_csc_benchmark.jsonl`: fixed shared-prefix prompts.
- `data/manifests/dianjin_csc_benchmark.json`: source hashes, tokenizer path,
  seed, row counts, and output hash.

The Go benchmark runner reads the normalized JSONL file. Set
`BENCHMARK_DATASET_PATH` only when the generated file lives outside the default
location.

This dataset is used for inference load generation, prefix-caching experiments,
and output-validity checks. It does not provide a gold answer for every prompt,
so semantic correctness must be evaluated separately from serving performance.
