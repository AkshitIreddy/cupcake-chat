class RuntimeDomainError(Exception):
    """Base class for expected product-domain failures."""


class NotFoundError(RuntimeDomainError):
    pass


class ConflictError(RuntimeDomainError):
    pass


class IntegrityViolation(RuntimeDomainError):
    pass


class ProjectBoundaryViolation(RuntimeDomainError):
    pass


class ProtocolViolation(RuntimeDomainError):
    pass
