import { describe, expect, it } from 'vitest';
import { artifacts, memories, models, tasks, tools } from './data';

describe('renderer fixtures', () => {
  it('keeps model selection explicit and covers every direct provider', () => {
    const cloudProviders = models
      .filter((model) => model.route === 'Cloud')
      .map((model) => model.provider);
    expect(cloudProviders).toEqual(
      expect.arrayContaining(['OpenAI', 'Anthropic', 'Google', 'xAI', 'Mistral', 'Cohere']),
    );
    expect(models.filter((model) => model.selected)).toHaveLength(1);
    expect(models.some((model) => /\bauto\b/i.test(model.name))).toBe(false);
  });

  it('ships a nonempty Cupcake Local catalog without third-party runtime fixtures', () => {
    const localModels = models.filter((model) => model.route === 'Local');
    expect(localModels).toHaveLength(3);
    expect(localModels.every((model) => model.provider === 'Cupcake Local')).toBe(true);
    expect(localModels.every((model) => model.status === 'catalog')).toBe(true);
    expect(localModels.map((model) => model.name)).toEqual([
      'Qwen3 8B · Q4_K_M',
      'Qwen3 4B · Q4_K_M',
      'Qwen3 14B · Q4_K_M',
    ]);
  });

  it('exercises durable task and memory states', () => {
    expect(new Set(tasks.map((task) => task.status))).toEqual(
      new Set(['working', 'waiting', 'complete', 'failed']),
    );
    expect(memories.every((memory) => memory.scope.length > 0 && memory.source.length > 0)).toBe(
      true,
    );
    expect(memories.some((memory) => memory.type === 'Temporary' && memory.expires)).toBe(true);
  });

  it('keeps approval-sensitive tools and versioned artifacts visible', () => {
    expect(
      tools.some((tool) => tool.permissions.some((permission) => permission.includes('Ask'))),
    ).toBe(true);
    expect(tools.some((tool) => tool.kind === 'mcp')).toBe(true);
    expect(artifacts.every((artifact) => artifact.revisions >= 1)).toBe(true);
  });
});
