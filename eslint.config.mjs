import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/**', 'node_modules/**'] },
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parser: tseslint.parser,
        },
        rules: {
            'no-constant-binary-expression': 'error',
            'no-duplicate-imports': 'error',
            'no-loss-of-precision': 'error',
            'no-unreachable': 'error',
            'no-unsafe-finally': 'error',
        },
    },
    {
        files: ['test/**/*.mjs'],
        rules: {
            'no-constant-binary-expression': 'error',
            'no-duplicate-imports': 'error',
            'no-loss-of-precision': 'error',
            'no-unreachable': 'error',
            'no-unsafe-finally': 'error',
        },
    },
    {
        files: ['src/app/core/backtest/**/*.ts', 'src/app/core/history/**/*.ts', 'src/market/price/**/*.ts'],
        plugins: {
            '@typescript-eslint': tseslint.plugin,
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
        },
    },
);
