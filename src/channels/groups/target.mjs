export const MAX_GROUP_ID_LENGTH = 100;

export function canonicalizeGroupUrl(value) {
  if (typeof value !== 'string') throw new Error('Invalid group URL');
  const match = /^https:\/\/(?:www\.|m\.)?facebook\.com\/groups\/([0-9]+)\/?(?:\?[^#\s\\]*)?(?:#[^\s\\]*)?$/.exec(value);
  if (!match || match[1].length > MAX_GROUP_ID_LENGTH || /[%\\\s]/.test(value)) throw new Error('Invalid group URL');
  return { groupId:match[1], canonicalUrl:`https://www.facebook.com/groups/${match[1]}` };
}
