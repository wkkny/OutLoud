import argparse
import json
import threading

import psutil

GIB = 1024**3


def resource_snapshot():
    memory = psutil.virtual_memory()
    swap = psutil.swap_memory()
    return {
        "ram_total_bytes": memory.total,
        "ram_available_bytes": memory.available,
        "ram_used_percent": memory.percent,
        "process_rss_bytes": psutil.Process().memory_info().rss,
        "swap_used_bytes": swap.used,
        "swap_in_bytes": swap.sin,
        "swap_out_bytes": swap.sout,
    }


class ResourceSampler:
    """Sample during a job without retaining an unbounded list of snapshots."""

    def __init__(self, interval=0.5):
        self.interval = interval
        self.finished = threading.Event()
        self.thread = None
        self.summary = {"sample_count": 0}

    def sample(self):
        try:
            snapshot = resource_snapshot()
        except Exception as error:
            self.summary["sampling_error"] = str(error)
            return
        summary = self.summary
        if summary["sample_count"] == 0:
            summary["before"] = snapshot
            summary["min_available_ram_bytes"] = snapshot["ram_available_bytes"]
            summary["peak_process_rss_bytes"] = snapshot["process_rss_bytes"]
            summary["peak_swap_used_bytes"] = snapshot["swap_used_bytes"]
        summary["after"] = snapshot
        summary["sample_count"] += 1
        summary["min_available_ram_bytes"] = min(
            summary["min_available_ram_bytes"], snapshot["ram_available_bytes"]
        )
        summary["peak_process_rss_bytes"] = max(
            summary["peak_process_rss_bytes"], snapshot["process_rss_bytes"]
        )
        summary["peak_swap_used_bytes"] = max(
            summary["peak_swap_used_bytes"], snapshot["swap_used_bytes"]
        )
        summary["swap_out_delta_bytes"] = max(
            0, snapshot["swap_out_bytes"] - summary["before"]["swap_out_bytes"]
        )

    def run(self):
        while not self.finished.wait(self.interval):
            self.sample()

    def start(self):
        self.sample()
        self.thread = threading.Thread(target=self.run)
        self.thread.start()

    def stop(self):
        self.finished.set()
        if self.thread is not None:
            self.thread.join()
        self.sample()
        return self.summary


def save_metrics(folder, metrics):
    # Observability failures must not turn a successful transcription into a failure.
    try:
        (folder / "metrics.json").write_text(
            json.dumps(metrics, indent=2) + "\n", encoding="utf-8"
        )
    except Exception as error:
        print(f"Could not save metrics: {error}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Watch host RAM and swap indicators")
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--count", type=int, default=None)
    args = parser.parse_args()
    if args.interval <= 0 or (args.count is not None and args.count <= 0):
        parser.error("interval and count must be positive")

    previous_swap_out = None
    wait = threading.Event()
    count = 0
    try:
        while args.count is None or count < args.count:
            snapshot = resource_snapshot()
            delta = 0 if previous_swap_out is None else max(
                0, snapshot["swap_out_bytes"] - previous_swap_out
            )
            previous_swap_out = snapshot["swap_out_bytes"]
            print(
                f"RAM available: {snapshot['ram_available_bytes'] / GIB:.2f} GiB | "
                f"RAM used: {snapshot['ram_used_percent']:.1f}% | "
                f"Swap used: {snapshot['swap_used_bytes'] / GIB:.2f} GiB | "
                f"Swap out since last sample: {delta / 1024**2:.1f} MiB",
                flush=True,
            )
            count += 1
            if args.count is None or count < args.count:
                wait.wait(args.interval)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
