import type { DiscourseCategory, DiscourseTopic, DiscourseTopicDetail } from './types';

// Discourse specific formatters
export function printDiscourseCategoryList(categories: DiscourseCategory[]): void {
  if (categories.length === 0) {
    console.log('No categories found');
    return;
  }

  console.log(`Categories (${categories.length})\n`);

  for (const cat of categories) {
    const parentInfo = cat.parentCategoryId ? ' (subcategory)' : '';
    console.log(`[${cat.id}] ${cat.name}${parentInfo}`);
    console.log(`    Slug: ${cat.slug}`);
    console.log(`    Topics: ${cat.topicCount} | Posts: ${cat.postCount}`);
    if (cat.description) {
      const desc = cat.description.replace(/<[^>]*>/g, '').substring(0, 100);
      if (desc) console.log(`    > ${desc}${cat.description.length > 100 ? '...' : ''}`);
    }
    console.log('');
  }
}

export function printDiscourseTopicList(topics: DiscourseTopic[]): void {
  if (topics.length === 0) {
    console.log('No topics found');
    return;
  }

  console.log(`Topics (${topics.length})\n`);

  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i];
    const flags: string[] = [];
    if (topic.pinned) flags.push('pinned');
    if (topic.closed) flags.push('closed');
    if (topic.archived) flags.push('archived');
    const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';

    console.log(`[${i + 1}] ${topic.id} | ${topic.title}${flagStr}`);
    if (topic.categoryName) console.log(`    Category: ${topic.categoryName}`);
    console.log(`    Posts: ${topic.postsCount} | Replies: ${topic.replyCount} | Views: ${topic.views} | Likes: ${topic.likeCount}`);
    console.log(`    Created: ${topic.createdAt}`);
    if (topic.lastPostedAt !== topic.createdAt) {
      console.log(`    Last Post: ${topic.lastPostedAt}`);
    }
    console.log('');
  }
}

export function printDiscourseTopic(topic: DiscourseTopicDetail): void {
  const flags: string[] = [];
  if (topic.pinned) flags.push('pinned');
  if (topic.closed) flags.push('closed');
  if (topic.archived) flags.push('archived');
  const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';

  console.log(`ID: ${topic.id}`);
  console.log(`Title: ${topic.title}${flagStr}`);
  console.log(`Slug: ${topic.slug}`);
  if (topic.categoryName) console.log(`Category: ${topic.categoryName}`);
  console.log(`Posts: ${topic.postsCount} | Replies: ${topic.replyCount} | Views: ${topic.views} | Likes: ${topic.likeCount}`);
  console.log(`Created: ${topic.createdAt}`);
  console.log(`Last Post: ${topic.lastPostedAt}`);
  console.log('---');

  for (const post of topic.posts) {
    const author = post.displayName || post.username;
    console.log(`\n[Post #${post.postNumber}] by ${author} (${post.createdAt})`);
    console.log(`Likes: ${post.likeCount} | Replies: ${post.replyCount}`);
    // Strip HTML from cooked content for display
    const content = post.cooked.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(content);
  }
}
