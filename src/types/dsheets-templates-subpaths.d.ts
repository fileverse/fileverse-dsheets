declare module '@fileverse-dev/dsheets-templates/template-metadata-list' {
  export interface TemplateListEntry {
    title: string;
    description: string;
    thumbnail: string;
    slug: string;
    fullImage: string;
    category?: string;
  }

  export const TEMPLATES: TemplateListEntry[];
}

declare module '@fileverse-dev/dsheets-templates/template-data-list' {
  export const TEMPLATES_DATA: {
    [templateId: string]: object[];
  };
  /** Fresh copy with new sheet ids. Absent in versions before it was added. */
  export const getTemplateData:
    | ((templateId: string) => object[] | undefined)
    | undefined;
}
