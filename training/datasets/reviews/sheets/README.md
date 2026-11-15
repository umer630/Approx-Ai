# Human review sheets (plain CSV — open in Google Sheets, Excel or any editor)

One folder per model; each `*.csv` is one sheet of 100 records (`*.meta.json` holds its checksum).
Nick 4.8 has 6 sheets. Fill only `reviewer`, `verdict` (`accept` / `reject`), `issue_tags`, `notes` —
never edit `prompt`/`answer`/ids. In Colab the notebook copies these to `MyDrive/ApproxAI/review-sheets/<model>/`
and imports completed copies from `MyDrive/ApproxAI/review-completed/<model>/` (`python -m datahub review-import`).

Note: the FAB 100X / FAB 500X sheets were issued from the earlier builds (90,000 / 708,436 records); rows whose
record is not in the current build are reported by the import and skipped.
