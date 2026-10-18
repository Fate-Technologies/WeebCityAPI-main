/** Import all type modules for their side effects, then build the schema. */
import { builder } from '../builder.js';
import './enums.js';
import './media.js';
import './entities.js';
import './query.js';

export const schema = builder.toSchema();
