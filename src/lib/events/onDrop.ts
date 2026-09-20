export const preventUnsupportedDrop = (event: DragEvent) => {
	event.preventDefault();
	event.stopPropagation();
};
