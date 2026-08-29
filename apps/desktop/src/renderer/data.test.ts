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

  it('includes local runtimes without bundling a ready model download', () => {
    expect(
      models.some((model) => model.provider === 'Cupcake Local' && model.status === 'download'),
    ).toBe(true);
    expect(models.some((model) => model.provider === 'Ollama' && model.status === 'ready')).toBe(
      true,
    );
    expect(
      models.some((model) => model.provider === 'LM Studio' && model.status === 'offline'),
    ).toBe(true);
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
