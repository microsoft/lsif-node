// @ts-check
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['**/lib/**', '**/node_modules/**', 'build/**', 'samples/**'],
	},
	{
		files: ['**/*.ts'],
		languageOptions: {
			globals: globals.node,
			parser: tseslint.parser,
		},
		plugins: {
			'@typescript-eslint': tseslint.plugin,
			'@stylistic': stylistic,
		},
		rules: {
			'@stylistic/semi': 'error',
			'@stylistic/member-delimiter-style': ['error', {
				multiline: { delimiter: 'semi', requireLast: true },
				singleline: { delimiter: 'semi', requireLast: false },
				multilineDetection: 'brackets',
			}],
			'indent': 'off',
			'@stylistic/indent': ['warn', 'tab', { SwitchCase: 1 }],
			'@typescript-eslint/no-floating-promises': 'error',
			'no-extra-semi': 'warn',
			'curly': 'warn',
			'quotes': ['error', 'single', { allowTemplateLiterals: true }],
			'eqeqeq': 'error',
			'constructor-super': 'warn',
			'prefer-const': ['warn', { destructuring: 'all' }],
			'no-caller': 'warn',
			'no-case-declarations': 'warn',
			'no-debugger': 'warn',
			'no-duplicate-case': 'warn',
			'no-duplicate-imports': 'warn',
			'no-eval': 'warn',
			'no-async-promise-executor': 'warn',
			'no-new-wrappers': 'warn',
			'no-redeclare': 'off',
			'no-sparse-arrays': 'warn',
			'no-throw-literal': 'warn',
			'no-unsafe-finally': 'warn',
			'no-unused-labels': 'warn',
			'no-restricted-globals': ['warn', 'name', 'length', 'event', 'closed', 'external', 'status', 'origin', 'orientation', 'context'],
			'no-var': 'warn',
			'@typescript-eslint/naming-convention': [
				'warn',
				{ selector: 'class', format: ['PascalCase'], leadingUnderscore: 'allow' },
			],
		},
	}
);
