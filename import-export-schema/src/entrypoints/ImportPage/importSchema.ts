import {
  defaultAppearanceForFieldType,
  isHardcodedEditor,
} from '@/utils/datocms/fieldTypeInfo';
import {
  validatorsContainingBlocks,
  validatorsContainingLinks,
} from '@/utils/datocms/schema';
import { type Client, type SchemaTypes, generateId } from '@datocms/cma-client';
import { withEventsSubscription } from '@datocms/rest-api-events';
import { get, isEqual, omit, pick, set, sortBy } from 'lodash-es';
import type { ImportDoc } from './buildImportDoc';

// biome-ignore lint/suspicious/noExplicitAny: Doesn't work with unknown :(
type PromiseGeneratorFn = (...args: any[]) => Promise<any>;

export type ImportProgress = { total: number; finished: number };

export default async function importSchema(
  importDoc: ImportDoc,
  rawClient: Client,
  updateProgress: (progress: ImportProgress) => void,
) {
  const [client, unsubscribe] = await withEventsSubscription(rawClient);

  let total = 0;
  let finished = 0;

  function track<T extends PromiseGeneratorFn>(promiseGeneratorFn: T): T {
    return (async (...args: Parameters<T>) => {
      total += 1;
      updateProgress({ total, finished });
      try {
        const result = await promiseGeneratorFn(...args);
        return result;
      } finally {
        finished += 1;
        updateProgress({ total, finished });
      }
    }) as T;
  }

  const { locales } = await client.site.find();

  const itemTypeIdMappings: Map<string, string> = new Map();
  const fieldIdMappings: Map<string, string> = new Map();
  const fieldsetIdMappings: Map<string, string> = new Map();
  const pluginIdMappings: Map<string, string> = new Map();

  for (const toCreate of importDoc.itemTypes.entitiesToCreate) {
    itemTypeIdMappings.set(toCreate.entity.id, generateId());

    for (const field of toCreate.fields) {
      fieldIdMappings.set(field.id, generateId());
    }

    for (const fieldset of toCreate.fieldsets) {
      fieldsetIdMappings.set(fieldset.id, generateId());
    }
  }

  for (const [exportId, projectId] of Object.entries(
    importDoc.itemTypes.idsToReuse,
  )) {
    itemTypeIdMappings.set(exportId, projectId);
  }

  for (const toCreate of importDoc.plugins.entitiesToCreate) {
    pluginIdMappings.set(toCreate.id, generateId());
  }

  for (const [exportId, projectId] of Object.entries(
    importDoc.plugins.idsToReuse,
  )) {
    pluginIdMappings.set(exportId, projectId);
  }

  // Create new plugins
  await Promise.all(
    importDoc.plugins.entitiesToCreate.map(
      track(async (plugin) => {
        const data: SchemaTypes.PluginCreateSchema['data'] = {
          type: 'plugin',
          id: pluginIdMappings.get(plugin.id),
          attributes: plugin.attributes.package_name
            ? pick(plugin.attributes, ['package_name'])
            : plugin.meta.version === '2'
              ? omit(plugin.attributes, ['parameters'])
              : omit(plugin.attributes, [
                  'parameter_definitions',
                  'field_types',
                  'plugin_type',
                  'parameters',
                ]),
        };

        await client.plugins.rawCreate({ data });

        if (!isEqual(plugin.attributes.parameters, {})) {
          try {
            await client.plugins.update(pluginIdMappings.get(plugin.id)!, {
              parameters: plugin.attributes.parameters,
            });
          } catch (e) {
            // NOP
            // Legacy plugin parameters might be invalid
          }
        }
      }),
    ),
  );

  // Create new item types
  await Promise.all(
    importDoc.itemTypes.entitiesToCreate.map(
      track(async (toCreate) => {
        const data: SchemaTypes.ItemTypeCreateSchema['data'] = {
          type: 'item_type',
          id: itemTypeIdMappings.get(toCreate.entity.id),
          attributes: omit(toCreate.entity.attributes, ['has_singleton_item']),
        };

        if (toCreate.rename) {
          data.attributes.name = toCreate.rename.name;
          data.attributes.api_key = toCreate.rename.apiKey;
        }

        await client.itemTypes.rawCreate({ data });
      }),
    ),
  );

  // Create fields and fieldsets
  await Promise.all(
    importDoc.itemTypes.entitiesToCreate.map(
      async ({ entity: { id: itemTypeId }, fields, fieldsets }) => {
        await Promise.all(
          fieldsets.map(
            track(async (fieldset) => {
              const data: SchemaTypes.FieldsetCreateSchema['data'] = {
                ...omit(fieldset, ['relationships']),
                id: fieldsetIdMappings.get(fieldset.id),
              };

              await client.fieldsets.rawCreate(
                itemTypeIdMappings.get(itemTypeId)!,
                {
                  data,
                },
              );
            }),
          ),
        );

        const nonSlugFields = fields.filter(
          (field) => field.attributes.field_type !== 'slug',
        );

        await Promise.all(
          nonSlugFields.map(
            track((field) =>
              importField(field, {
                client,
                locales,
                fieldIdMappings,
                pluginIdMappings,
                fieldsetIdMappings,
                itemTypeIdMappings,
              }),
            ),
          ),
        );

        const slugFields = fields.filter(
          (field) => field.attributes.field_type === 'slug',
        );

        await Promise.all(
          slugFields.map(
            track((field) =>
              importField(field, {
                client,
                locales,
                fieldIdMappings,
                pluginIdMappings,
                fieldsetIdMappings,
                itemTypeIdMappings,
              }),
            ),
          ),
        );
      },
    ),
  );

  // Reorder fields and fieldsets
  await Promise.all(
    importDoc.itemTypes.entitiesToCreate.map(
      track(async ({ fields, fieldsets }) => {
        const allEntities = [...fieldsets, ...fields];

        if (allEntities.length <= 1) {
          return;
        }

        for (const entity of sortBy(allEntities, ['attributes', 'position'])) {
          if (entity.type === 'fieldset') {
            await client.fieldsets.update(fieldsetIdMappings.get(entity.id)!, {
              position: entity.attributes.position,
            });
          } else {
            await client.fields.update(fieldIdMappings.get(entity.id)!, {
              position: entity.attributes.position,
            });
          }
        }
      }),
    ),
  );

  unsubscribe();
}

type ImportFieldOptions = {
  client: Client;
  locales: string[];
  fieldIdMappings: Map<string, string>;
  fieldsetIdMappings: Map<string, string>;
  itemTypeIdMappings: Map<string, string>;
  pluginIdMappings: Map<string, string>;
};

async function importField(
  field: SchemaTypes.Field,
  {
    client,
    locales,
    fieldIdMappings,
    fieldsetIdMappings,
    itemTypeIdMappings,
    pluginIdMappings,
  }: ImportFieldOptions,
) {
  const data: SchemaTypes.FieldCreateSchema['data'] = {
    ...field,
    id: fieldIdMappings.get(field.id),
    relationships: {
      fieldset: {
        data: field.relationships.fieldset.data
          ? {
              type: 'fieldset',
              id: fieldsetIdMappings.get(field.relationships.fieldset.data.id)!,
            }
          : null,
      },
    },
  };

  const validators = [
    ...validatorsContainingLinks.filter(
      (i) => i.field_type === field.attributes.field_type,
    ),
    ...validatorsContainingBlocks.filter(
      (i) => i.field_type === field.attributes.field_type,
    ),
  ].map((i) => i.validator);

  for (const validator of validators) {
    const fieldLinkedItemTypeIds = get(
      field.attributes.validators,
      validator,
    ) as string[];

    const newIds: string[] = [];

    for (const fieldLinkedItemTypeId of fieldLinkedItemTypeIds) {
      if (itemTypeIdMappings.has(fieldLinkedItemTypeId)) {
        newIds.push(itemTypeIdMappings.get(fieldLinkedItemTypeId)!);
      }
    }

    set(data.attributes.validators!, validator, newIds);
  }

  const slugTitleFieldValidator = field.attributes.validators
    .slug_title_field as undefined | { title_field_id: string };

  if (slugTitleFieldValidator) {
    data.attributes.validators!.slug_title_field = {
      title_field_id: fieldIdMappings.get(
        slugTitleFieldValidator.title_field_id,
      )!,
    };
  }

  data.attributes.appeareance = undefined;

  if (!(await isHardcodedEditor(field.attributes.appearance.editor))) {
    if (pluginIdMappings.has(field.attributes.appearance.editor)) {
      data.attributes.appearance!.editor = pluginIdMappings.get(
        field.attributes.appearance.editor,
      )!;
    } else {
      data.attributes.appearance = await defaultAppearanceForFieldType(
        field.attributes.field_type,
      );
    }
  }

  if (field.attributes.localized) {
    const oldDefaultValues = field.attributes.default_value as Record<
      string,
      unknown
    >;
    data.attributes.default_value = Object.fromEntries(
      locales.map((locale) => [locale, oldDefaultValues[locale] || null]),
    );
  }

  data.attributes.appearance!.addons = field.attributes.appearance.addons
    .filter((addon) => pluginIdMappings.has(addon.id))
    .map((addon) => ({ ...addon, id: pluginIdMappings.get(addon.id)! }));

  try {
    await client.fields.rawCreate(
      itemTypeIdMappings.get(field.relationships.item_type.data.id)!,
      {
        data,
      },
    );
  } catch (e) {
    console.log(data, e);
    throw e;
  }
}
