from cupcake_runtime.domain.ids import uuid7


def test_uuid7_has_expected_bits_and_monotonic_order() -> None:
    values = [uuid7(timestamp_ms=1_700_000_000_000) for _ in range(100)]
    assert values == sorted(values)
    assert len(set(values)) == len(values)
    assert all(value.version == 7 for value in values)
    assert all(value.variant == "specified in RFC 4122" for value in values)


def test_uuid7_rejects_out_of_range_timestamp() -> None:
    try:
        uuid7(timestamp_ms=1 << 48)
    except ValueError as error:
        assert "48" in str(error)
    else:
        raise AssertionError("out-of-range timestamp was accepted")
