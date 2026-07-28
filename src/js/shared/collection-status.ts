export const collectionSkipMessage = (unsupportedCount: number) =>
  unsupportedCount > 0 ? `Skipped ${unsupportedCount} unsupported` : null;

export const appendCollectionSkipMessage = (
  message: string,
  unsupportedCount: number,
) => {
  const skipped = collectionSkipMessage(unsupportedCount);
  return skipped ? `${message}; ${skipped}` : message;
};

export const collectionUnchangedMessage = (
  sourceName: string | null,
  hasGradientSelection: boolean,
  gradientSlotMode: boolean,
  uniteDuplicates = false,
) => {
  if (uniteDuplicates) {
    return "No items added; matching items may already exist or the palette may not have enough room";
  }
  if (sourceName) return `Palette does not have room for all colors from ${sourceName}`;
  if (hasGradientSelection) {
    return gradientSlotMode
      ? "Palette does not have room for all selected items"
      : "Palette does not have room for all selected gradient stops";
  }
  return "Palette does not have room for all selected colors";
};
