const FS_MODULES = new Map([
  ["fs", "fs"],
  ["node:fs", "fs"],
  ["fs/promises", "promises"],
  ["node:fs/promises", "promises"],
]);
const WRAPPERS = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);
const UNKNOWN = Symbol("unknown");
const ABSENT = Symbol("absent");

function unwrap(node) {
  let current = node;
  while (current && WRAPPERS.has(current.type)) {
    current = current.expression;
  }
  return current;
}
function propertyName(node, computed = false) {
  if (!node) {
    return undefined;
  }
  if (!computed && node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "Literal") {
    return node.value;
  }
  return undefined;
}
function member(receiver, key) {
  if (receiver === "fs" && key === "promises") {
    return "promises";
  }
  if (
    (receiver === "fs" || receiver === "promises") &&
    (key === "readdir" || key === "readdirSync")
  ) {
    return "read";
  }
  return undefined;
}

export default {
  meta: {
    type: "problem",
    messages: {
      unsafe:
        "Recursive readdir can follow directory symlinks and exhaust memory. Use listDirectoryTreeStrict/listDirectoryTreeStrictSync from src/infra/directory-walk (plugins: openclaw/plugin-sdk/file-access-runtime).",
      unverifiable:
        "Cannot verify nonrecursive readdir options. Use listDirectoryTreeStrict/listDirectoryTreeStrictSync, or pass statically known options with recursive:false (or no recursive option).",
    },
  },
  create(context) {
    // Resource exhaustion is equally dangerous in tests, QA, UI, packages and tooling.
    // Unlike type/assertion policy, this rule covers every file admitted by oxlint.
    const references = new Map();
    const variableFor = (node) => references.get(node.start);
    function initializer(node, visited) {
      const variable = variableFor(node);
      if (!variable || visited.has(variable)) {
        return undefined;
      }
      const definition = variable.defs[0];
      if (
        definition?.type !== "Variable" ||
        definition.parent.kind !== "const" ||
        variable.references.some((reference) => reference.isWrite() && !reference.init)
      ) {
        return undefined;
      }
      visited.add(variable);
      return definition.node;
    }
    function kind(expression, visited = new Set()) {
      const node = unwrap(expression);
      if (!node) {
        return undefined;
      }
      if (node.type === "MemberExpression") {
        return member(kind(node.object, visited), propertyName(node.property, node.computed));
      }
      if (node.type === "AwaitExpression") {
        return kind(node.argument, visited);
      }
      if (node.type === "ImportExpression") {
        return FS_MODULES.get(propertyName(node.source, true));
      }
      if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        !variableFor(node.callee)?.defs.length
      ) {
        return FS_MODULES.get(propertyName(node.arguments[0], true));
      }
      if (node.type !== "Identifier") {
        return undefined;
      }
      const variable = variableFor(node);
      const definition = variable?.defs[0];
      if (definition?.type === "ImportBinding") {
        const receiver = FS_MODULES.get(definition.parent.source.value);
        return definition.node.type === "ImportSpecifier"
          ? member(receiver, propertyName(definition.node.imported))
          : receiver;
      }
      const binding = initializer(node, visited);
      if (!binding?.init) {
        return undefined;
      }
      const receiver = kind(binding.init, visited);
      if (binding.id.type === "Identifier") {
        return receiver;
      }
      if (binding.id.type === "ObjectPattern") {
        const property = binding.id.properties.find(
          (candidate) =>
            candidate.type === "Property" &&
            candidate.value.type === "Identifier" &&
            variable.identifiers.some((id) => id.start === candidate.value.start),
        );
        return property
          ? member(receiver, propertyName(property.key, property.computed))
          : undefined;
      }
      return undefined;
    }
    function literal(expression, visited = new Set()) {
      const node = unwrap(expression);
      if (node?.type === "Literal") {
        return node.value;
      }
      if (node?.type === "Identifier") {
        if (node.name === "undefined" && !variableFor(node)?.defs.length) {
          return undefined;
        }
        const binding = initializer(node, visited);
        if (binding?.id.type === "Identifier") {
          return literal(binding.init, visited);
        }
      }
      return UNKNOWN;
    }
    function recursion(expression, visited = new Set()) {
      const node = unwrap(expression);
      if (!node) {
        return ABSENT;
      }
      if (node.type === "Identifier") {
        const binding = initializer(node, visited);
        if (binding?.id.type === "Identifier") {
          return recursion(binding.init, visited);
        }
        return node.name === "undefined" && !variableFor(node)?.defs.length ? ABSENT : UNKNOWN;
      }
      // Encoding-only calls, null/undefined options, and callback-only readdir do not recurse.
      if (node.type === "Literal" && (node.value === null || typeof node.value === "string")) {
        return ABSENT;
      }
      if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
        return ABSENT;
      }
      if (node.type !== "ObjectExpression") {
        return UNKNOWN;
      }
      let recursive = ABSENT;
      for (const property of node.properties) {
        if (property.type === "SpreadElement") {
          // An unknown spread may override a previous false; an explicit false after it is safe.
          const spread = recursion(property.argument, new Set(visited));
          if (spread !== ABSENT) {
            recursive = spread;
          }
        } else if (property.type === "Property") {
          const key = propertyName(property.key, property.computed);
          if (key === undefined) {
            recursive = UNKNOWN;
          } else if (key === "recursive") {
            recursive =
              property.kind === "init" ? literal(property.value, new Set(visited)) : UNKNOWN;
          }
        }
      }
      return recursive;
    }
    return {
      Program() {
        for (const scope of context.sourceCode.scopeManager.scopes) {
          for (const reference of scope.references) {
            references.set(reference.identifier.start, reference.resolved);
          }
        }
      },
      CallExpression(node) {
        if (kind(node.callee) !== "read") {
          return;
        }
        const recursive = recursion(node.arguments[1]);
        if (recursive === false || recursive === undefined || recursive === ABSENT) {
          return;
        }
        context.report({ node, messageId: recursive === true ? "unsafe" : "unverifiable" });
      },
    };
  },
};
