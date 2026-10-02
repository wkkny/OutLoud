CAPACITY_MESSAGE = "Transcription capacity is full. Wait for a job to finish before recording again."


class CapacityUnavailable(RuntimeError):
    def __init__(self):
        super().__init__(CAPACITY_MESSAGE)
