import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

/**
 * 前后端共用一套规则，差异只在环境与 React 插件。
 *
 * 只开带类型信息的那套（recommendedTypeChecked）：不带类型的规则拦不住
 * 这个项目真正容易出事的地方——浮着没 await 的 Promise、错判的类型断言。
 * 格式一律交给 prettier，eslint 不碰（prettier 配置放最后关掉所有格式规则）。
 */
export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts"] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // 未使用的变量按下划线前缀豁免，与既有代码里 _impact 之类的写法一致
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // 空 catch 在这个项目里是刻意的（清理失败不该拦住主流程），但必须写注释说明
      "no-empty": ["error", { allowEmptyCatch: true }],
      // 闭包里先读后写的定时器变量（procs.ts 的 killTimer）不能改 const，会撞 TDZ
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      // 关掉 require-await：Fastify 的路由处理器和体检函数都用统一的 async 签名，
      // 里面有没有 await 是实现细节。真正能抓 bug 的 no-floating-promises 与
      // no-misused-promises 仍然开着
      "@typescript-eslint/require-await": "off",
    },
  },

  {
    files: ["server/**/*.ts"],
    languageOptions: { globals: globals.node },
  },

  {
    files: ["web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.es2024 } },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },

  // 这些文件确实不在任何 tsconfig 的 include 里，类型感知规则跑不了，
  // 只跑语法与逻辑规则。server 的测试文件不在此列——它们现在进
  // tsconfig.json（只管检查），构建走 tsconfig.build.json 把测试排掉
  {
    files: ["**/*.mjs", "*.config.js", "**/vitest.config.ts"],
    languageOptions: { globals: globals.node },
    extends: [tseslint.configs.disableTypeChecked],
  },

  {
    files: ["**/*.test.ts", "**/*.test.tsx", "web/src/test/**/*.{ts,tsx}"],
    rules: {
      // 测试里造假数据、往 window 上塞桩，断言用得着这些
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },

  // 放最后：关掉所有与 prettier 冲突的格式规则
  prettier,
);
