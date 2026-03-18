import rootConfig from '../eslint.config.mjs';
import tseslint from 'typescript-eslint';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
	...rootConfig,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					defaultProject: path.join(__dirname, 'tsconfig.json'),
				},
			},
		},
	}
);
