/**
 * A complete French dictionary (typed `Labels`, so a new label fails the
 * type check here until it is translated): the localization rows read it,
 * and `site/content/docs/customization/localization.mdx` shows the same.
 */
import type { Labels } from '$lib/labels.js';

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
		triggerMenu: 'Suggestions',
		searching: 'Recherche…',
		noResults: 'Aucun résultat'
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
		placeholders: {
			heading: (level) => `Titre ${level}`,
			toggleHeading: (level) => `Titre dépliant ${level}`,
			list: 'Liste',
			todo: 'Tâche',
			toggle: 'Liste dépliante',
			quote: 'Citation vide',
			callout: 'Écrivez quelque chose…',
			caption: 'Ajoutez une légende…',
			empty: 'Tapez « / » pour les commandes'
		}
	},
	toolbar: {
		bar: 'Mise en forme',
		text: 'Texte',
		turnInto: 'Transformer en',
		link: 'Lien',
		linkUrl: 'Adresse du lien',
		linkPlaceholder: 'Collez un lien',
		apply: 'Appliquer',
		applyLink: 'Appliquer le lien',
		remove: 'Retirer',
		removeLink: 'Retirer le lien',
		color: 'Couleur',
		textColor: 'Couleur du texte',
		backgroundColor: 'Couleur de fond',
		colors: {
			Default: 'Par défaut',
			Gray: 'Gris',
			Brown: 'Marron',
			Orange: 'Orange',
			Yellow: 'Jaune',
			Green: 'Vert',
			Blue: 'Bleu',
			Purple: 'Violet',
			Pink: 'Rose',
			Red: 'Rouge'
		},
		colorText: (color) => `Texte ${color.toLowerCase()}`,
		colorBackground: (color) => `Fond ${color.toLowerCase()}`,
		card: 'Lien',
		open: 'Ouvrir',
		openLink: 'Ouvrir le lien dans un nouvel onglet',
		edit: 'Modifier',
		editLink: 'Modifier le lien'
	},
	slashMenu: {
		filter: 'Tapez pour filtrer…',
		filterLabel: 'Filtrer les commandes',
		list: 'Commandes de blocs',
		noResults: 'Aucun résultat',
		close: 'Fermer le menu',
		closeKey: 'échap',
		groups: {
			'Basic blocks': 'Blocs de base',
			'Advanced blocks': 'Blocs avancés',
			Media: 'Médias',
			Layout: 'Mise en page',
			Color: 'Couleur'
		}
	},
	blockMenu: {
		search: 'Rechercher une action…',
		searchLabel: 'Rechercher une action',
		menu: 'Actions du bloc',
		block: 'Bloc',
		turnInto: 'Transformer en',
		color: 'Couleur',
		textColor: 'Couleur du texte',
		backgroundColor: 'Couleur de fond',
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
		noResults: 'Aucun résultat',
		ctrl: 'Ctrl',
		shift: 'Maj',
		deleteKey: 'Suppr'
	},
	blockHandles: {
		add: (kind) => `Ajouter un bloc sous ${kind} (Alt : au-dessus)`,
		addBeside: (kind) => `Ajouter un bloc sous ${kind} (Alt : une colonne à droite)`,
		addHint: 'Cliquez pour ajouter dessous\nAlt-clic pour ajouter au-dessus',
		addBesideHint: 'Cliquez pour ajouter dessous\nAlt-clic pour ajouter une colonne à droite',
		grip: (kind) => `Bloc ${kind} : glissez pour déplacer, cliquez pour les actions`
	},
	image: {
		image: 'Image',
		add: 'Ajouter une image',
		link: "Lien de l'image",
		linkPlaceholder: "Collez le lien de l'image…",
		embed: "Intégrer l'image",
		upload: 'Téléverser',
		uploading: 'Téléversement…',
		tooLarge: (limit, upload) =>
			`Les images en ligne sont limitées à ${limit} : ${upload ? 'téléversez plutôt le fichier' : "hébergez l'image et collez son lien"}.`,
		uploadFailed: 'Le téléversement a échoué : réessayez ou collez un lien.',
		invalid: "Ce n'est pas un lien ou un fichier d'image.",
		toolbar: 'Image',
		alignLeft: 'Aligner à gauche',
		alignCenter: 'Centrer',
		alignRight: 'Aligner à droite',
		alt: 'Texte alternatif',
		altPlaceholder: "Décrivez l'image…"
	},
	media: {
		embed: {
			label: 'Intégration',
			offer: 'Intégrer',
			add: 'Intégrer un lien',
			placeholder: 'Collez le lien…',
			submit: 'Intégrer le lien',
			invalid: 'Aucun service intégré ne lit ce lien.'
		},
		bookmark: {
			label: 'Signet web',
			offer: 'Signet',
			add: 'Ajouter un signet web',
			placeholder: 'Collez le lien…',
			submit: 'Créer le signet',
			invalid: "Ce n'est pas un lien web."
		},
		file: {
			label: 'Fichier',
			add: 'Intégrer un fichier',
			addOrUpload: 'Téléverser ou intégrer un fichier',
			placeholder: 'Collez le lien du fichier…',
			submit: 'Intégrer le lien',
			invalid: "Ce n'est pas un lien ou un fichier."
		},
		video: {
			label: 'Vidéo',
			add: 'Intégrer une vidéo',
			placeholder: 'Collez le lien de la vidéo…',
			submit: 'Intégrer la vidéo',
			invalid: "Ce n'est pas un lien ou un fichier vidéo."
		},
		audio: {
			label: 'Audio',
			add: 'Intégrer un audio',
			placeholder: "Collez le lien de l'audio…",
			submit: "Intégrer l'audio",
			invalid: "Ce n'est pas un lien ou un fichier audio."
		},
		upload: 'Téléverser',
		fileSize: octets,
		pasteAs: 'Coller comme',
		pasteLink: 'Lien'
	},
	code: {
		code: 'Code',
		language: 'Langage du code',
		copy: 'Copier',
		copied: 'Copié',
		languages: { plaintext: 'Texte brut' }
	},
	find: {
		bar: 'Rechercher dans la page',
		query: 'Rechercher',
		queryPlaceholder: 'Rechercher dans la page',
		noResults: 'Aucun résultat',
		count: (current, total) => `${current} sur ${total}`,
		matchCase: 'Respecter la casse',
		previous: 'Résultat précédent',
		previousHint: 'Résultat précédent (Maj+Entrée)',
		next: 'Résultat suivant',
		nextHint: 'Résultat suivant (Entrée)',
		close: 'Fermer',
		closeHint: 'Fermer (Échap)',
		replaceWith: 'Remplacer par',
		replace: 'Remplacer',
		replaceAll: 'Tout remplacer'
	},
	suggestions: {
		suggestion: 'Proposition',
		writing: (label) => `${label ?? "L'IA"} écrit…`,
		accept: 'Accepter',
		discard: 'Ignorer',
		retry: 'Réessayer',
		ctrl: 'Ctrl',
		escape: 'Échap'
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
		menu: 'Pages',
		searching: 'Recherche…',
		noResults: 'Aucun résultat',
		untitled: 'Sans titre'
	},
	mention: {
		menu: 'Personnes',
		searching: 'Recherche…',
		noResults: 'Personne ne correspond'
	},
	history: {
		title: 'Historique des versions',
		versions: 'Versions',
		morning: 'Matin',
		evening: 'Soir',
		loading: 'Chargement…',
		empty: 'Aucune version. Une version est enregistrée deux fois par jour quand la page change.',
		noEditors: 'Aucun auteur',
		moreEditors: (count) => `+${count}`,
		saved: 'Enregistrée',
		preview: 'Aperçu de la version',
		choose: 'Choisissez une version pour l’afficher.',
		highlight: 'Surligner les changements',
		added: (count) => `${count} ajouté${count > 1 ? 's' : ''} depuis`,
		removed: (count) => `${count} supprimé${count > 1 ? 's' : ''} depuis`,
		changed: (count) => `${count} modifié${count > 1 ? 's' : ''} depuis`,
		same: 'Identique à la page actuelle',
		restore: 'Restaurer la version',
		restoring: 'Restauration…',
		undo: 'Annuler la restauration',
		restored: 'Version restaurée.',
		unchanged: 'La page correspond déjà à cette version.',
		unavailable: 'Cette version n’est plus disponible.',
		undone: 'Restauration annulée.',
		nothingToUndo: 'Aucune restauration à annuler.',
		denied: 'Vous n’avez pas accès à cet historique.',
		failed: 'L’historique est injoignable.'
	}
};

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
