/**
 * The web's shapes in shared/business.ts match what the server sends: each
 * schema row, with its dates as strings, must fit the shared view.
 */
import { describe, expectTypeOf, test } from 'vitest';
import type { z } from 'zod';
import type { fieldDefSchema } from '@/core/records/fields';
import type { FieldDef } from './record-fields';
import type { CaseEntityType } from '@/core/cases/status';
import type { ResolvedCaseLink } from '@/core/cases/links';
import type { PublicForm } from '@/core/records/forms';
import type { Case } from '@/db/schema/cases';
import type { Contact } from '@/db/schema/contacts';
import type { FormLink, RecordRow, RecordType } from '@/db/schema/records';
import type {
  CaseEntityValue,
  CaseLinkView,
  CaseView,
  ContactView,
  FormLinkView,
  PublicFormView,
  RecordTypeView,
  RecordView,
} from './business';

type Wire<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };
type WithoutSourceRef<T> = Omit<T, 'sourceRef'>;

describe('shared business shapes', () => {
  test('rows fit their views', () => {
    expectTypeOf<WithoutSourceRef<Wire<Case>>>().toExtend<CaseView>();
    expectTypeOf<Wire<Contact>>().toExtend<ContactView>();
    expectTypeOf<Wire<ResolvedCaseLink>>().toExtend<CaseLinkView>();
    expectTypeOf<Wire<RecordType>>().toExtend<RecordTypeView>();
    expectTypeOf<WithoutSourceRef<Wire<RecordRow>>>().toExtend<RecordView>();
    expectTypeOf<Wire<Omit<FormLink, 'tokenHash'>>>().toExtend<FormLinkView>();
    expectTypeOf<PublicForm>().toEqualTypeOf<PublicFormView>();
    expectTypeOf<CaseEntityType>().toEqualTypeOf<CaseEntityValue>();
    // The shared field shape is the validator's output, field for field.
    expectTypeOf<z.infer<typeof fieldDefSchema>>().toEqualTypeOf<FieldDef>();
  });
});
