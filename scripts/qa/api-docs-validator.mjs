const ROOT_OPERATION_TYPES = new Set(['Query', 'Mutation']);

const REQUIRED_ENTRY_FIELDS = [
  'Knowledge State',
  'Context',
  'Use Case',
  'Actor',
  'Authorization',
  'Input',
  'Result',
  'Error',
  'Idempotency',
  'Concurrency / Retry',
  'Compatibility',
  'Schema',
  'Implementation',
  'Test',
];

const ALLOWED_KNOWLEDGE_STATES = new Set([
  'Confirmed',
  'Proposed',
  'Open Question',
]);
const REQUIRED_REPOSITORY_REFERENCE_FIELDS = new Set([
  'Schema',
  'Implementation',
  'Test',
]);

const OPERATION_HEADING_PATTERN =
  /^## ((Query|Mutation)\.([_A-Za-z][_0-9A-Za-z]*))\s*$/gm;
const ENTRY_FIELD_PATTERN = /^- ([A-Za-z][A-Za-z /]+):\s*(.+)$/gm;
const MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\(([^)]+)\)/g;

const maskGraphqlIgnoredText = (source) => {
  let masked = '';

  for (let index = 0; index < source.length; index += 1) {
    if (source.startsWith('"""', index)) {
      masked += '   ';
      index += 3;
      while (index < source.length && !source.startsWith('"""', index)) {
        masked += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      if (index < source.length) {
        masked += '   ';
        index += 2;
      }
      continue;
    }

    if (source[index] === '"') {
      masked += ' ';
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          masked += '  ';
          index += 2;
          continue;
        }
        if (source[index] === '"') {
          break;
        }
        masked += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      if (index < source.length) {
        masked += ' ';
      }
      continue;
    }

    if (source[index] === '#') {
      while (index < source.length && source[index] !== '\n') {
        masked += ' ';
        index += 1;
      }
      masked += '\n';
      continue;
    }

    masked += source[index];
  }

  return masked;
};

const findClosingBrace = (source, openingBraceIndex) => {
  let depth = 1;

  for (let index = openingBraceIndex + 1; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  throw new Error('GraphQL SDL contains an unclosed root operation type');
};

const findRootTypeOpeningBrace = (source, typeNameEndIndex) => {
  const delimiters = [];

  for (let index = typeNameEndIndex; index < source.length; index += 1) {
    const character = source[index];

    if (character === '(' || character === '[') {
      delimiters.push(character);
      continue;
    }
    if (character === ')' && delimiters.at(-1) === '(') {
      delimiters.pop();
      continue;
    }
    if (character === ']' && delimiters.at(-1) === '[') {
      delimiters.pop();
      continue;
    }
    if (character === '{') {
      if (delimiters.length === 0) {
        return index;
      }
      delimiters.push(character);
      continue;
    }
    if (character === '}' && delimiters.at(-1) === '{') {
      delimiters.pop();
    }
  }

  throw new Error('GraphQL SDL root operation type body was not found');
};

const collectFieldsFromRootType = (typeName, body) => {
  const operations = [];
  let argumentDepth = 0;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];

    if (argumentDepth === 0 && character === '@') {
      index += 1;
      while (/[_0-9A-Za-z]/.test(body[index] ?? '')) {
        index += 1;
      }
      while (/\s/.test(body[index] ?? '')) {
        index += 1;
      }
      if (body[index] === '(') {
        let directiveDepth = 1;
        while (directiveDepth > 0 && index + 1 < body.length) {
          index += 1;
          if (body[index] === '(') {
            directiveDepth += 1;
          } else if (body[index] === ')') {
            directiveDepth -= 1;
          }
        }
      } else {
        index -= 1;
      }
      continue;
    }

    if (character === '(') {
      argumentDepth += 1;
      continue;
    }
    if (character === ')') {
      argumentDepth -= 1;
      continue;
    }
    if (argumentDepth > 0 || !/[_A-Za-z]/.test(character)) {
      continue;
    }

    const nameStart = index;
    while (/[_0-9A-Za-z]/.test(body[index + 1] ?? '')) {
      index += 1;
    }
    const name = body.slice(nameStart, index + 1);
    let nextTokenIndex = index + 1;
    while (/\s/.test(body[nextTokenIndex] ?? '')) {
      nextTokenIndex += 1;
    }

    if (body[nextTokenIndex] === ':' || body[nextTokenIndex] === '(') {
      operations.push(`${typeName}.${name}`);
    }
  }

  return operations;
};

/**
 * GraphQL SDLからtop-level Query／Mutation fieldを抽出する。
 *
 * @param {string} source GraphQL SDL。
 * @returns {string[]} `Query.field`または`Mutation.field`形式の昇順一覧。
 * @throws {Error} root operation typeのbodyがない、または閉じていない場合。
 */
export const collectGraphqlRootOperations = (source) => {
  const syntaxSource = maskGraphqlIgnoredText(source);
  const operations = [];
  const rootTypePattern = /\b(?:extend\s+)?type\s+(Query|Mutation)\b/g;
  let typeMatch;

  while ((typeMatch = rootTypePattern.exec(syntaxSource)) !== null) {
    const typeName = typeMatch[1];
    if (!ROOT_OPERATION_TYPES.has(typeName)) {
      continue;
    }

    const openingBraceIndex = findRootTypeOpeningBrace(
      syntaxSource,
      rootTypePattern.lastIndex,
    );
    const closingBraceIndex = findClosingBrace(syntaxSource, openingBraceIndex);
    const body = syntaxSource.slice(openingBraceIndex + 1, closingBraceIndex);
    operations.push(...collectFieldsFromRootType(typeName, body));
    rootTypePattern.lastIndex = closingBraceIndex + 1;
  }

  return [...new Set(operations)].sort();
};

const collectMarkdownLinks = (source) =>
  [...source.matchAll(MARKDOWN_LINK_PATTERN)].map((match) => match[1]);

const normalizeRepositoryReference = (reference) => reference.split('#', 1)[0];

const isExternalReference = (reference) =>
  reference.startsWith('http://') ||
  reference.startsWith('https://') ||
  reference.startsWith('mailto:') ||
  reference.startsWith('#');

const isRepositoryReference = (reference) => !isExternalReference(reference);

const isInvalidRepositoryReference = (reference) =>
  !isExternalReference(reference) &&
  (reference.startsWith('/') ||
    reference.startsWith('\\') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference));

/**
 * GraphQL Operation catalogを構造化する。
 *
 * @param {string} source `docs/api/graphql-contracts.md`形式のMarkdown。
 * @returns {Array<{operation: string, fields: Map<string, string>}>} Operation entry一覧。
 * @throws {Error} 同じOperationのentryまたは同一entry内の項目が重複する場合。
 */
export const parseGraphqlContractCatalog = (source) => {
  const headingMatches = [...source.matchAll(OPERATION_HEADING_PATTERN)];
  const h2HeadingMatches = [...source.matchAll(/^##\s+.+$/gm)];
  const entries = [];
  const seenOperations = new Set();

  for (const headingMatch of headingMatches) {
    const operation = headingMatch[1];
    if (seenOperations.has(operation)) {
      throw new Error(`Duplicate catalog entry: ${operation}`);
    }
    seenOperations.add(operation);

    const sectionStart = headingMatch.index + headingMatch[0].length;
    const sectionEnd =
      h2HeadingMatches.find(({ index }) => index > headingMatch.index)?.index ??
      source.length;
    const section = source.slice(sectionStart, sectionEnd);
    const fields = new Map();
    for (const fieldMatch of section.matchAll(ENTRY_FIELD_PATTERN)) {
      const field = fieldMatch[1];
      if (fields.has(field)) {
        throw new Error(`${operation} has duplicate field: ${field}`);
      }
      fields.set(field, fieldMatch[2].trim());
    }

    entries.push({ operation, fields });
  }

  return entries;
};

/**
 * SDLとGraphQL Operation catalogの完全性、必須項目、参照先を検証する。
 *
 * @param {object} input 検証入力。
 * @param {string} input.schemaSource GraphQL SDL。
 * @param {string} input.catalogSource Operation catalog Markdown。
 * @param {(reference: string) => boolean} input.referenceExists Repository参照の存在判定。
 * @throws {Error} Operation集合、必須項目、Knowledge State、Repository参照の検証に失敗した場合。
 */
export const validateGraphqlContractCatalog = ({
  schemaSource,
  catalogSource,
  referenceExists,
}) => {
  const schemaOperations = collectGraphqlRootOperations(schemaSource);
  const entries = parseGraphqlContractCatalog(catalogSource);
  const catalogOperations = entries.map(({ operation }) => operation).sort();
  const catalogOperationSet = new Set(catalogOperations);
  const schemaOperationSet = new Set(schemaOperations);

  const missingEntries = schemaOperations.filter(
    (operation) => !catalogOperationSet.has(operation),
  );
  const absentFromSchema = catalogOperations.filter(
    (operation) => !schemaOperationSet.has(operation),
  );
  const operationMismatchMessages = [];
  if (missingEntries.length > 0) {
    operationMismatchMessages.push(
      `Missing catalog entries: ${missingEntries.join(', ')}`,
    );
  }
  if (absentFromSchema.length > 0) {
    operationMismatchMessages.push(
      `Catalog entries absent from SDL: ${absentFromSchema.join(', ')}`,
    );
  }
  if (operationMismatchMessages.length > 0) {
    throw new Error(operationMismatchMessages.join('; '));
  }

  for (const { operation, fields } of entries) {
    for (const field of REQUIRED_ENTRY_FIELDS) {
      if (!fields.has(field)) {
        throw new Error(`${operation} is missing required field: ${field}`);
      }
    }

    const knowledgeState = fields.get('Knowledge State');
    if (!ALLOWED_KNOWLEDGE_STATES.has(knowledgeState)) {
      throw new Error(
        `${operation} has invalid Knowledge State: ${knowledgeState}`,
      );
    }

    for (const field of REQUIRED_ENTRY_FIELDS) {
      const links = collectMarkdownLinks(fields.get(field));
      const invalidReference = links.find(isInvalidRepositoryReference);
      if (invalidReference) {
        throw new Error(`Invalid repository reference: ${invalidReference}`);
      }
      const references = links.filter(isRepositoryReference);
      if (
        REQUIRED_REPOSITORY_REFERENCE_FIELDS.has(field) &&
        references.length === 0
      ) {
        throw new Error(
          `${operation} ${field} must contain a repository reference`,
        );
      }

      for (const reference of references) {
        const normalizedReference = normalizeRepositoryReference(reference);
        if (!referenceExists(normalizedReference)) {
          throw new Error(
            `Repository reference does not exist: ${normalizedReference}`,
          );
        }
      }
    }
  }
};
