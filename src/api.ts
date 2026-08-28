import { openValue, sealValue } from './lib/crypto';
import { db } from './lib/db';
import { createHandler } from './router';

export const handler = createHandler(db, { sealValue, openValue });
