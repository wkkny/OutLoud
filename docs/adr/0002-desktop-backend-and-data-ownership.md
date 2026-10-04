# Desktop owns its backend and separate saved data

Electron manages a private Python backend lifecycle and saves desktop recordings and conversations in its per-user data directory, rather than attaching to a browser backend or reusing repository-relative data. This avoids ambiguous process ownership and accidental cross-client shutdown, at the cost of separate conversation libraries and an explicit future migration; closing the window drains accepted transcription work, with forced termination available only after a loss warning.
