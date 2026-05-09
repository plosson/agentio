import matter from 'gray-matter';

export interface ServiceMeta {
  name: string;
  slug: string;
  auth: string;
  tagline: string;
  icon: string;
  order: number;
}

export interface ParsedService {
  meta: ServiceMeta;
  body: string;
}

const REQUIRED: Array<keyof ServiceMeta> = ['name', 'slug', 'auth', 'tagline', 'icon'];

export function parseServiceFrontmatter(raw: string, sourcePath: string): ParsedService {
  const parsed = matter(raw);
  const data = parsed.data as Partial<ServiceMeta>;

  for (const key of REQUIRED) {
    if (data[key] === undefined || data[key] === '') {
      throw new Error(`${sourcePath}: missing required field '${key}' in frontmatter`);
    }
  }

  return {
    meta: {
      name: data.name as string,
      slug: data.slug as string,
      auth: data.auth as string,
      tagline: data.tagline as string,
      icon: data.icon as string,
      order: typeof data.order === 'number' ? data.order : 999,
    },
    body: parsed.content,
  };
}
