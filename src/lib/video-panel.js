export function ambiguityRetryCopy(item) {
  if (item.ambiguityKind === 'image') {
    return { title: 'Regenerate a fresh start image?', body: 'The earlier fresh start image request may have used credits. Regenerating the fresh start image may use credits twice.', confirmLabel: 'Regenerate image and accept risk', status: 'Fresh start image regeneration accepted with duplicate-credit risk.' };
  }
  return { title: 'Resubmit paid video generation?', body: 'The earlier paid video request may have used credits. Resubmitting the paid video may use credits twice.', confirmLabel: 'Resubmit video and accept risk', status: 'Paid video resubmission accepted with duplicate-credit risk.' };
}
