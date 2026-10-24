import { isSkippedTypeAssertionTestPath } from "./type-assertion-guard-scope.mjs";

function name(node) {
  return node?.type === "Identifier"
    ? node.name
    : node?.type === "Literal"
      ? node.value
      : undefined;
}

export default {
  meta: {
    type: "problem",
    messages: {
      unsafe:
        "Recursive readdir can follow directory symlinks and exhaust memory. Use walkDirectory/walkDirectorySync from src/infra/directory-walk (plugins: openclaw/plugin-sdk/file-access-runtime).",
    },
  },
  create(context) {
    const file = context.physicalFilename.replaceAll("\\", "/");
    const cwd = context.cwd.replaceAll("\\", "/");
    const relative = file.startsWith(cwd + "/") ? file.slice(cwd.length + 1) : file;
    if (
      !["src/", "extensions/", "scripts/", "test/fixtures/oxlint-boundary-guards/"].some((root) =>
        relative.startsWith(root),
      ) ||
      isSkippedTypeAssertionTestPath(relative)
    ) {
      return {};
    }
    const functions = new Set(["readdir", "readdirSync"]);
    return {
      ImportDeclaration(node) {
        if (!["fs", "node:fs", "fs/promises", "node:fs/promises"].includes(node.source.value)) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier" && functions.has(name(specifier.imported))) {
            functions.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        const called = callee.type === "MemberExpression" ? name(callee.property) : name(callee);
        if (!functions.has(called)) {
          return;
        }
        const options = node.arguments[1];
        if (options?.type !== "ObjectExpression") {
          return;
        }
        if (
          options.properties.some(
            (property) =>
              property.type === "Property" &&
              name(property.key) === "recursive" &&
              property.value.type === "Literal" &&
              property.value.value === true,
          )
        ) {
          context.report({ node, messageId: "unsafe" });
        }
      },
    };
  },
};
