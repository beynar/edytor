/**
 * The package's words in French (`fr`, typed `Labels`, so a new label
 * fails the type check here until it is translated), the code languages'
 * names and the slash keywords: what a French view's `<Edytor labels>` and
 * code plugin take. The localization rows read them, and
 * `site/content/docs/customization/localization.mdx` shows the same. The
 * demo chrome's French words are `words.fr.ts`.
 */
import type { Labels } from '$lib/labels.js';
import { CODE_LANGUAGES } from '$lib/plugins/code/languages.js';

const octets = (count: number) => {
	const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
	let value = count;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	const shown = unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0).replace('.', ',');
	return `${shown} ${units[unit]}`;
};

export const fr: Labels = {
	editor: {
		suggestion: 'Proposition',
		block: (kind) => `bloc ${kind}`,
		blocks: (count) => `${count} blocs`,
		movedUp: (what) => `${what} déplacé vers le haut`,
		movedDown: (what) => `${what} déplacé vers le bas`,
		indented: (what) => `${what} indenté`,
		outdented: (what) => `${what} désindenté`,
		moved: (what) => `${what} déplacé`,
		deleted: (what) => `${what} supprimé`,
		moveRefused: 'Les blocs ne se déplacent pas dans une proposition'
	},
	richText: {
		kinds: {
			paragraph: 'Texte',
			heading1: 'Titre 1',
			heading2: 'Titre 2',
			heading3: 'Titre 3',
			toggleHeading1: 'Titre dépliant 1',
			toggleHeading2: 'Titre dépliant 2',
			toggleHeading3: 'Titre dépliant 3',
			bulletedList: 'Liste à puces',
			numberedList: 'Liste numérotée',
			todoList: 'Liste de tâches',
			toggleList: 'Liste dépliante',
			callout: 'Encadré',
			quote: 'Citation',
			divider: 'Séparateur'
		},
		marks: {
			bold: 'Gras',
			italic: 'Italique',
			underline: 'Souligné',
			strike: 'Barré',
			code: 'Code'
		},
		checkbox: 'Fait',
		emptyBody: {
			toggle: 'Bloc dépliant vide. Cliquez ou déposez des blocs ici.',
			callout: 'Encadré vide. Cliquez ou déposez des blocs ici.'
		},
		calloutIcon: {
			change: 'Changer l’icône',
			add: 'Ajouter une icône'
		},
		placeholders: {
			heading: (level) => `Titre ${level}`,
			toggleHeading: (level) => `Titre dépliant ${level}`,
			list: 'Liste',
			todo: 'Tâche',
			toggle: 'Liste dépliante',
			quote: 'Citation vide',
			callout: 'Titre de l’encadré',
			caption: 'Ajoutez une légende…',
			empty: 'Tapez « / » pour les commandes'
		}
	},
	blockMenu: {
		turnInto: 'Transformer en',
		color: 'Couleur',
		colors: {
			default: 'Par défaut',
			gray: 'Gris',
			brown: 'Marron',
			orange: 'Orange',
			yellow: 'Jaune',
			green: 'Vert',
			blue: 'Bleu',
			purple: 'Violet',
			pink: 'Rose',
			red: 'Rouge'
		},
		colorText: (color) => `Texte ${color.toLowerCase()}`,
		colorBackground: (color) => `Fond ${color.toLowerCase()}`,
		copyLink: 'Copier le lien du bloc',
		duplicate: 'Dupliquer',
		moveUp: 'Monter',
		moveDown: 'Descendre',
		delete: 'Supprimer',
		ctrl: 'Ctrl',
		shift: 'Maj',
		deleteKey: 'Suppr'
	},
	image: {
		image: 'Image'
	},
	media: {
		embed: 'Intégration',
		bookmark: 'Signet web',
		file: 'Fichier',
		video: 'Vidéo',
		audio: 'Audio',
		fileSize: octets,
		uploading: 'Envoi…'
	},
	code: {
		code: 'Code'
	},
	columns: {
		columns: (count) => `${count} colonnes`,
		resize: 'Redimensionner les colonnes'
	},
	page: {
		page: 'Page',
		untitled: 'Sans titre'
	},
	toc: {
		toc: 'Table des matières',
		untitled: 'Sans titre',
		empty: 'Ajoutez des titres pour créer une table des matières.'
	},
	pageLink: {
		untitled: 'Sans titre'
	},
	comments: {
		comment: 'Commenter',
		sidebar: 'Commentaires'
	},
	table: {
		table: 'Tableau',
		headerRow: 'Ligne d’en-tête',
		headerColumn: 'Colonne d’en-tête',
		insertRowAbove: 'Insérer une ligne au-dessus',
		insertRowBelow: 'Insérer une ligne en dessous',
		insertColumnLeft: 'Insérer une colonne à gauche',
		insertColumnRight: 'Insérer une colonne à droite',
		deleteRow: 'Supprimer la ligne',
		deleteColumn: 'Supprimer la colonne',
		resize: 'Redimensionner la colonne',
		emptyCell: 'Cellule vide'
	},
	equation: {
		block: 'Équation en bloc',
		inline: 'Équation en ligne',
		blockPlaceholder: 'Ajouter une équation TeX',
		inlinePlaceholder: 'Nouvelle équation',
		invalid: 'Équation invalide'
	}
};

/** The code languages, named in French where the name differs. */
export const frLanguages = CODE_LANGUAGES.map((language) =>
	language.id === 'plaintext' ? { ...language, label: 'Texte brut' } : language
);

/** The French slash keywords, by command id (they replace the English ones: the English names are kept in them). */
export const frKeywords: Record<string, string[]> = {
	'block.paragraph': ['texte', 'paragraphe', 'paragraph'],
	'block.heading1': ['titre', 'h1'],
	'block.heading2': ['sous-titre', 'h2'],
	'block.heading3': ['h3'],
	'block.bulleted-list-item': ['puce', 'ul'],
	'block.numbered-list-item': ['numéro', 'ol'],
	'block.todo-item': ['tâche', 'case', 'todo'],
	'block.toggle': ['dépliant', 'details'],
	'block.toggle-heading1': ['dépliant', 'replier'],
	'block.toggle-heading2': ['dépliant', 'replier'],
	'block.toggle-heading3': ['dépliant', 'replier'],
	'block.callout': ['note', 'astuce'],
	'block.quote': ['citation', 'quote'],
	'block.divider': ['séparateur', 'hr'],
	'block.toc': ['sommaire', 'plan', 'toc'],
	'page.new': ['sous-page', 'nouvelle page', 'document', 'lien']
};
