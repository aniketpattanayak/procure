import { PipeTransform } from '@nestjs/common';
import { AppError } from '../../core/errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `@Param('id', new UuidParam('User'))` — anything that is not a uuid cannot exist, so it is a 404. */
export class UuidParam implements PipeTransform<string, string> {
  constructor(private readonly what = 'Record') {}
  transform(value: string): string {
    if (typeof value !== 'string' || !UUID_RE.test(value)) throw AppError.notFound(this.what);
    return value;
  }
}
