import '../src/config/load-local-environment.js';
import { loadEnvironment } from '../src/config/env.js';
import { runDeploymentMigrations } from '../src/db/deployment-migrations.js';

const env = loadEnvironment();
console.log(await runDeploymentMigrations(env));
