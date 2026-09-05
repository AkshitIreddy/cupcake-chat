export function PersonaPortrait({
  value,
  name,
  className = '',
}: {
  value?: string;
  name: string;
  className?: string;
}) {
  const match = /^atlas:(\d+)$/.exec(value ?? '');
  if (match) {
    const index = Math.max(0, Math.min(19, Number(match[1])));
    const column = index % 5;
    const row = Math.floor(index / 5);
    return (
      <span
        className={`group-persona-portrait ${className}`.trim()}
        style={{
          backgroundImage: 'url(/art/cupcake-avatar-atlas-v1.webp)',
          backgroundSize: '500% 400%',
          backgroundPosition: `${(column / 4) * 100}% ${(row / 3) * 100}%`,
        }}
        role="img"
        aria-label={`${name}'s portrait`}
      />
    );
  }
  return (
    <img
      className={`group-persona-portrait ${className}`.trim()}
      src={
        value?.startsWith('/brand/') || value?.startsWith('/art/')
          ? value
          : '/brand/cupcake-mark.svg'
      }
      alt={`${name}'s portrait`}
    />
  );
}
