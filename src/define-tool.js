/**
 * Offline fallback for `@deepseek-ai/dsh-tools`'s `defineTool`.
 *
 * Why: the host bundles that package inside `app.asar`, so a plugin loaded from
 * the profile's `node_modules` cannot resolve it. Importing it eagerly makes
 * the whole plugin fail before registering anything. We try the real package
 * first (see index.js `loadDefineTool`), then fall back to this compiler, which
 * reproduces the author-spec → JSON Schema translation the host performs:
 *   - a property's `required: true` is lifted into the parent `required` array
 *     and removed from the property schema;
 *   - `type: 'json'` is author-only and degrades to an annotation-only schema;
 *   - `properties` / `items` recurse, everything else passes through.
 *
 * It does NOT validate arguments at runtime; handlers keep their own defaults.
 */

const AUTHOR_ONLY_JSON = 'json';

function compilePropertyMap(map, path) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error(`${path} 必须是对象（属性名 → 值 schema）`);
  }
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(map)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error(`${path}.${key} 必须是值 schema 对象`);
    }
    const { required: mark, ...rest } = spec;
    if (mark !== undefined && mark !== true) throw new Error(`${path}.${key}.required 写了就只能是 true`);
    if (mark === true) required.push(key);
    properties[key] = compileValue(rest, `${path}.${key}`);
  }
  return required.length > 0 ? { properties, required } : { properties };
}

function compileValue(spec, path) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`${path} 必须是值 schema 对象`);
  }
  const out = {};
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'required') continue;
    if (key === 'properties') {
      const compiled = compilePropertyMap(value, `${path}.properties`);
      out.properties = compiled.properties;
      if (compiled.required) out.required = compiled.required;
      continue;
    }
    if (key === 'items') {
      out.items = compileValue(value, `${path}.items`);
      continue;
    }
    if (key === 'type' && value === AUTHOR_ONLY_JSON) continue;
    out[key] = value;
  }
  return out;
}

export function parametersToJsonSchema(spec) {
  const { properties, required } = compilePropertyMap(spec, 'parameters');
  return { type: 'object', properties, ...(required ? { required } : {}) };
}

export function outputSchemaToJsonSchema(spec) {
  return compileValue(spec, 'schema');
}

export function defineToolCompat(options) {
  if (!options || typeof options !== 'object') throw new Error('defineTool: options 必须是对象');
  const { name, description, parameters, output, execute } = options;
  if (typeof name !== 'string' || !name) throw new Error('defineTool: name 必须是非空字符串');
  if (!output || typeof output !== 'object') throw new Error(`defineTool(${name}): 缺 output`);
  if (typeof output.render !== 'function') throw new Error(`defineTool(${name}): output.render 必须是函数`);
  if (typeof execute !== 'function') throw new Error(`defineTool(${name}): execute 必须是函数`);

  const tool = {
    name,
    description,
    parameters: parametersToJsonSchema(parameters ?? {}),
    output: {
      schema: outputSchemaToJsonSchema(output.schema ?? {}),
      render: output.render,
      ...(typeof output.presentationMeta === 'function' ? { presentationMeta: output.presentationMeta } : {}),
    },
    ...(options.deferLoading === true ? { deferLoading: true } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args, exec) {
      return execute(args, exec);
    },
  };
  if (typeof options.projectContent === 'function') tool.projectContent = options.projectContent;
  if (typeof options.finalizeContent === 'function') tool.finalizeContent = options.finalizeContent;
  if (typeof options.presentCall === 'function') tool.presentCall = options.presentCall;
  if (typeof options.presentResult === 'function') tool.presentResult = options.presentResult;
  if (typeof options.isConcurrencySafe === 'function') tool.isConcurrencySafe = options.isConcurrencySafe;
  return tool;
}
