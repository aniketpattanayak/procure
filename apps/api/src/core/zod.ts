import { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

/** @Body(new Zod(Schema)) — validates and returns the parsed (coerced, defaulted) value. */
export class Zod<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}
  transform(value: unknown, _meta: ArgumentMetadata): z.infer<S> {
    return this.schema.parse(value); // ZodError -> ProblemFilter -> 400 VALIDATION_FAILED
  }
}
