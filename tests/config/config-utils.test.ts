import { describe, it, expect } from 'vitest';
import { resolveVariables } from '../../src/config/resolve-variables.js';
import { resolveConfigTemplates } from '../../src/config/resolve-config-templates.js';

// ============================================================================
// resolveVariables
// ============================================================================

describe('resolveVariables', () => {
  it('replaces ${KEY} in strings', () => {
    const config = { name: 'agent-${ID}', path: '${DIR}/tools' };
    const result = resolveVariables(config, { ID: 'abc', DIR: '/opt' });
    expect(result).toEqual({ name: 'agent-abc', path: '/opt/tools' });
  });

  it('leaves unmatched variables as-is', () => {
    const config = { cmd: '${KNOWN} ${UNKNOWN}' };
    const result = resolveVariables(config, { KNOWN: 'yes' });
    expect(result.cmd).toBe('yes ${UNKNOWN}');
  });

  it('handles nested objects', () => {
    const config = {
      tasks: {
        fetch: {
          config: { url: 'https://${HOST}/api', timeout: 5000 },
          provides: ['data-${SUFFIX}'],
        },
      },
    };
    const result = resolveVariables(config, { HOST: 'example.com', SUFFIX: 'v2' });
    expect((result.tasks as any).fetch.config.url).toBe('https://example.com/api');
    expect((result.tasks as any).fetch.provides[0]).toBe('data-v2');
  });

  it('handles arrays', () => {
    const config = { items: ['${A}', '${B}', 'literal'] };
    const result = resolveVariables(config, { A: 'x', B: 'y' });
    expect(result.items).toEqual(['x', 'y', 'literal']);
  });

  it('passes through numbers/booleans/null', () => {
    const config = { count: 5, enabled: true, data: null, name: '${X}' } as any;
    const result = resolveVariables(config, { X: 'val' });
    expect(result.count).toBe(5);
    expect(result.enabled).toBe(true);
    expect(result.data).toBeNull();
    expect(result.name).toBe('val');
  });

  it('supports numeric and boolean variable values', () => {
    const config = { port: '${PORT}', debug: '${DEBUG}' };
    const result = resolveVariables(config, { PORT: 8080, DEBUG: true });
    expect(result.port).toBe('8080');
    expect(result.debug).toBe('true');
  });

  it('does not mutate the original config', () => {
    const config = { name: '${X}' };
    const result = resolveVariables(config, { X: 'replaced' });
    expect(config.name).toBe('${X}');
    expect(result.name).toBe('replaced');
  });

  it('handles multiple variables in one string', () => {
    const config = { cmd: '${DIR}/${SCRIPT} ${ENTITY_ID}-input.json' };
    const result = resolveVariables(config, {
      DIR: '/tools',
      SCRIPT: 'analyze.py',
      ENTITY_ID: 'url-42',
    });
    expect(result.cmd).toBe('/tools/analyze.py url-42-input.json');
  });

  it('works with an empty variables map', () => {
    const config = { a: '${X}', b: 'literal' };
    const result = resolveVariables(config, {});
    expect(result).toEqual({ a: '${X}', b: 'literal' });
  });

  it('works with a real super-agent style config', () => {
    const config = {
      variables: { ENTITY_ID: 'default', TOOLS_DIR: '/tools' },
      tasks: {
        'url-connects': {
          config: {
            cmd: 'python',
            'cmd-args': '${TOOLS_DIR}/url-connects.py ${ENTITY_ID}-input.json ${ENTITY_ID}-result.json',
          },
          provides: ['connection-evidence'],
        },
      },
    };
    const vars = { ENTITY_ID: 'ticket-99', TOOLS_DIR: '/opt/phish/tools' };
    const result = resolveVariables(config, vars);
    expect((result.tasks as any)['url-connects'].config['cmd-args']).toBe(
      '/opt/phish/tools/url-connects.py ticket-99-input.json ticket-99-result.json',
    );
  });
});

// ============================================================================
// resolveConfigTemplates
// ============================================================================

describe('resolveConfigTemplates', () => {
  it('merges template into task config and removes reference', () => {
    const config = {
      configTemplates: {
        PYTHON_TOOL: { cmd: 'python', timeout: 30000, cwd: '/workdata' },
      },
      tasks: {
        analyze: {
          provides: ['analysis'],
          config: { 'config-template': 'PYTHON_TOOL', 'cmd-args': 'analyze.py input.json' },
        },
      },
    };
    const result = resolveConfigTemplates(config);
    expect((result.tasks as any).analyze.config).toEqual({
      cmd: 'python',
      timeout: 30000,
      cwd: '/workdata',
      'cmd-args': 'analyze.py input.json',
    });
    // Template reference removed
    expect((result.tasks as any).analyze.config['config-template']).toBeUndefined();
    // configTemplates key removed from top level
    expect(result['configTemplates']).toBeUndefined();
  });

  it('supports kebab-case config-templates key', () => {
    const config = {
      'config-templates': {
        NODE_CMD: { cmd: 'node', timeout: 60000 },
      },
      tasks: {
        build: {
          provides: ['build-done'],
          config: { 'config-template': 'NODE_CMD', script: 'build.js' },
        },
      },
    };
    const result = resolveConfigTemplates(config);
    expect((result.tasks as any).build.config).toEqual({
      cmd: 'node',
      timeout: 60000,
      script: 'build.js',
    });
    expect(result['config-templates']).toBeUndefined();
  });

  it('task-level values override template values', () => {
    const config = {
      configTemplates: {
        BASE: { cmd: 'python', timeout: 30000, cwd: '/default' },
      },
      tasks: {
        special: {
          provides: ['done'],
          config: { 'config-template': 'BASE', timeout: 120000, cwd: '/custom' },
        },
      },
    };
    const result = resolveConfigTemplates(config);
    expect((result.tasks as any).special.config).toEqual({
      cmd: 'python',
      timeout: 120000,
      cwd: '/custom',
    });
  });

  it('deep-merges nested objects one level', () => {
    const config = {
      configTemplates: {
        API: {
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'bot/1.0' },
          method: 'POST',
        },
      },
      tasks: {
        call: {
          provides: ['response'],
          config: {
            'config-template': 'API',
            headers: { Authorization: 'Bearer xyz' },
            url: 'https://api.example.com',
          },
        },
      },
    };
    const result = resolveConfigTemplates(config);
    expect((result.tasks as any).call.config.headers).toEqual({
      'Content-Type': 'application/json',
      'User-Agent': 'bot/1.0',
      Authorization: 'Bearer xyz',
    });
    expect((result.tasks as any).call.config.method).toBe('POST');
    expect((result.tasks as any).call.config.url).toBe('https://api.example.com');
  });

  it('leaves tasks without config-template untouched', () => {
    const config = {
      configTemplates: { T: { cmd: 'python' } },
      tasks: {
        plain: { provides: ['done'], config: { cmd: 'bash', script: 'run.sh' } },
      },
    };
    const result = resolveConfigTemplates(config);
    expect((result.tasks as any).plain.config).toEqual({ cmd: 'bash', script: 'run.sh' });
  });

  it('handles missing template gracefully (strips reference)', () => {
    const config = {
      configTemplates: {},
      tasks: {
        orphan: {
          provides: ['done'],
          config: { 'config-template': 'NONEXISTENT', 'cmd-args': 'run.py' },
        },
      },
    };
    const result = resolveConfigTemplates(config);
    expect((result.tasks as any).orphan.config).toEqual({ 'cmd-args': 'run.py' });
    expect((result.tasks as any).orphan.config['config-template']).toBeUndefined();
  });

  it('works with steps (step-machine configs)', () => {
    const config = {
      configTemplates: {
        LLM: { model: 'gpt-4', temperature: 0.7 },
      },
      steps: {
        classify: {
          produces_data: ['category'],
          config: { 'config-template': 'LLM', prompt: 'Classify this ticket' },
        },
      },
    };
    const result = resolveConfigTemplates(config);
    expect((result.steps as any).classify.config).toEqual({
      model: 'gpt-4',
      temperature: 0.7,
      prompt: 'Classify this ticket',
    });
  });

  it('returns config as-is when no tasks or steps', () => {
    const config = { settings: { timeout: 5000 } };
    const result = resolveConfigTemplates(config);
    expect(result).toEqual({ settings: { timeout: 5000 } });
  });

  it('does not mutate the original config', () => {
    const config = {
      configTemplates: { T: { cmd: 'python' } },
      tasks: {
        a: { provides: ['done'], config: { 'config-template': 'T', extra: true } },
      },
    };
    const original = JSON.parse(JSON.stringify(config));
    resolveConfigTemplates(config);
    expect(config).toEqual(original);
  });

  it('multiple tasks can use different templates', () => {
    const config = {
      configTemplates: {
        PY: { cmd: 'python', cwd: '/py' },
        NODE: { cmd: 'node', cwd: '/js' },
      },
      tasks: {
        analyze: { provides: ['a'], config: { 'config-template': 'PY', script: 'a.py' } },
        build: { provides: ['b'], config: { 'config-template': 'NODE', script: 'b.js' } },
        plain: { provides: ['c'], config: { script: 'c.sh' } },
      },
    };
    const result = resolveConfigTemplates(config);
    expect((result.tasks as any).analyze.config).toEqual({ cmd: 'python', cwd: '/py', script: 'a.py' });
    expect((result.tasks as any).build.config).toEqual({ cmd: 'node', cwd: '/js', script: 'b.js' });
    expect((result.tasks as any).plain.config).toEqual({ script: 'c.sh' });
  });
});

// ============================================================================
// Composing both: resolveConfigTemplates + resolveVariables
// ============================================================================

describe('resolveConfigTemplates + resolveVariables composed', () => {
  it('templates first, then variables — mimics super-agent pattern', () => {
    const config = {
      'config-templates': {
        'PYTHON-TOOL': { cmd: 'python', timeout: 30000, cwd: '${WORKDIR}' },
      },
      tasks: {
        'url-connects': {
          provides: ['connection-evidence'],
          config: {
            'config-template': 'PYTHON-TOOL',
            'cmd-args': '${TOOLS_DIR}/url-connects.py ${ENTITY_ID}-input.json',
          },
        },
        'security-analyzer': {
          provides: ['security-evidence'],
          requires: ['content-evidence'],
          config: {
            'config-template': 'PYTHON-TOOL',
            'cmd-args': '${TOOLS_DIR}/security-analyzer.py ${ENTITY_ID}-input.json',
          },
        },
      },
    };

    // Step 1: resolve templates
    const templated = resolveConfigTemplates(config);
    // Step 2: resolve variables
    const resolved = resolveVariables(templated, {
      WORKDIR: '/data/workdata',
      TOOLS_DIR: '/opt/tools',
      ENTITY_ID: 'url-42',
    });

    expect((resolved.tasks as any)['url-connects'].config).toEqual({
      cmd: 'python',
      timeout: 30000,
      cwd: '/data/workdata',
      'cmd-args': '/opt/tools/url-connects.py url-42-input.json',
    });
    expect((resolved.tasks as any)['security-analyzer'].config).toEqual({
      cmd: 'python',
      timeout: 30000,
      cwd: '/data/workdata',
      'cmd-args': '/opt/tools/security-analyzer.py url-42-input.json',
    });
    // Templates block removed
    expect(resolved['config-templates']).toBeUndefined();
  });
});
