// Minimal JSON-schema-subset validator: enough for tool arguments, action
// envelopes, and eval expectations. Deliberately not a full JSON Schema
// implementation — supported keywords are listed in SchemaNode.
export interface SchemaNode {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: SchemaNode;
  enum?: (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

export interface ValidationError {
  path: string;
  message: string;
}

export function validate(schema: SchemaNode, value: unknown, path = '$'): ValidationError[] {
  const errors: ValidationError[] = [];

  if (schema.const !== undefined && value !== schema.const) {
    errors.push({ path, message: `expected constant ${JSON.stringify(schema.const)}` });
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value as never)) {
    errors.push({ path, message: `expected one of ${JSON.stringify(schema.enum)}` });
    return errors;
  }

  if (schema.type) {
    const ok =
      (schema.type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) ||
      (schema.type === 'array' && Array.isArray(value)) ||
      (schema.type === 'string' && typeof value === 'string') ||
      (schema.type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (schema.type === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
      (schema.type === 'boolean' && typeof value === 'boolean') ||
      (schema.type === 'null' && value === null);
    if (!ok) {
      errors.push({ path, message: `expected ${schema.type}, got ${Array.isArray(value) ? 'array' : typeof value}` });
      return errors;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push({ path, message: `shorter than minLength ${schema.minLength}` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push({ path, message: `longer than maxLength ${schema.maxLength}` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))
      errors.push({ path, message: `does not match pattern ${schema.pattern}` });
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push({ path, message: `below minimum ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push({ path, message: `above maximum ${schema.maximum}` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push({ path, message: `fewer than minItems ${schema.minItems}` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push({ path, message: `more than maxItems ${schema.maxItems}` });
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validate(schema.items as SchemaNode, item, `${path}[${i}]`)));
    }
  }

  if (schema.type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push({ path: `${path}.${key}`, message: 'required property missing' });
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) errors.push(...validate(sub, obj[key], `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(obj)) {
        if (!known.has(key)) errors.push({ path: `${path}.${key}`, message: 'unexpected property' });
      }
    }
  }

  return errors;
}
