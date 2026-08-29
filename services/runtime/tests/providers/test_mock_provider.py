import asyncio

from cupcake_runtime.providers.mock import MOCK_DESCRIPTOR, MockProviderAdapter
from cupcake_runtime.providers.types import CanonicalMessage, ModelRequest, StreamEventType


def test_mock_stream_is_deterministic_and_sequenced() -> None:
    async def collect():
        adapter = MockProviderAdapter()
        request = ModelRequest(
            MOCK_DESCRIPTOR.id,
            (CanonicalMessage("user", "hello"),),
            metadata={"mock_chunk_size": 4},
        )
        return [event async for event in adapter.stream(request)]

    events = asyncio.run(collect())
    assert [event.sequence for event in events] == list(range(len(events)))
    assert events[0].type == StreamEventType.START
    assert (
        "".join(event.text or "" for event in events if event.type == StreamEventType.TEXT_DELTA)
        == "Cupcake received: hello"
    )
    assert events[-2].usage is not None
    assert events[-1].type == StreamEventType.FINISH
