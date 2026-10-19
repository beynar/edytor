/**
 * The demo chrome's words in French (typed `ChromeWords`, so a new word
 * fails the type check here until it is translated): what its menus, bars,
 * panels and cards show and say in a French view (`setWords(frWords)`).
 */
import type { ChromeWords } from '$registry/edytor/chrome/words.svelte.js';

/** The demo chrome's words in French. */
export const frWords: ChromeWords = {
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
			Color: 'Couleur',
			Inline: 'En ligne'
		}
	},
	blockHandles: {
		add: (kind) => `Ajouter un bloc sous ${kind} (Alt : au-dessus)`,
		addBeside: (kind) => `Ajouter un bloc sous ${kind} (Alt : une colonne à droite)`,
		addHint: 'Cliquez pour ajouter dessous\nAlt-clic pour ajouter au-dessus',
		addBesideHint: 'Cliquez pour ajouter dessous\nAlt-clic pour ajouter une colonne à droite',
		grip: (kind) => `Bloc ${kind} : glissez pour déplacer, cliquez pour les actions`
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
		escape: 'Échap',
		author: (name, via) => (via ? `${name} (${via === 'ai' ? 'IA' : via})` : name),
		reject: 'Refuser',
		withdraw: 'Retirer',
		pending: 'Proposé',
		suggesting: 'Suggestion',
		editing: 'Modification',
		acceptAll: 'Tout accepter',
		rejectAll: 'Tout refuser'
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
	},
	blockMenu: {
		turnInto: 'Transformer en',
		color: 'Couleur',
		search: 'Rechercher une action…',
		searchLabel: 'Rechercher une action',
		menu: 'Actions du bloc',
		block: 'Bloc',
		textColor: 'Couleur du texte',
		backgroundColor: 'Couleur de fond',
		noResults: 'Aucun résultat'
	},
	image: {
		image: 'Image',
		add: 'Ajouter une image',
		link: "Lien de l'image",
		linkPlaceholder: "Collez le lien de l'image…",
		embed: "Intégrer l'image",
		upload: 'Téléverser',
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
			add: 'Intégrer un lien',
			placeholder: 'Collez le lien…',
			submit: 'Intégrer le lien',
			invalid: 'Aucun service intégré ne lit ce lien.'
		},
		bookmark: {
			add: 'Ajouter un signet web',
			placeholder: 'Collez le lien…',
			submit: 'Créer le signet',
			invalid: "Ce n'est pas un lien web."
		},
		file: {
			add: 'Intégrer un fichier',
			addOrUpload: 'Téléverser ou intégrer un fichier',
			placeholder: 'Collez le lien du fichier…',
			submit: 'Intégrer le lien',
			invalid: "Ce n'est pas un lien ou un fichier."
		},
		video: {
			add: 'Intégrer une vidéo',
			placeholder: 'Collez le lien de la vidéo…',
			submit: 'Intégrer la vidéo',
			invalid: "Ce n'est pas un lien ou un fichier vidéo."
		},
		audio: {
			add: 'Intégrer un audio',
			placeholder: "Collez le lien de l'audio…",
			submit: "Intégrer l'audio",
			invalid: "Ce n'est pas un lien ou un fichier audio."
		},
		upload: 'Téléverser',
		uploading: 'Téléversement…',
		uploadFailed: 'Le téléversement a échoué : réessayez ou collez un lien.'
	},
	urlPaste: { menu: 'Coller comme', link: 'Lien', embed: 'Intégrer', bookmark: 'Signet' },
	code: {
		language: 'Langage du code',
		search: 'Rechercher un langage…',
		noResults: 'Aucun résultat',
		copy: 'Copier',
		copied: 'Copié'
	},
	calloutIcons: { picker: 'Icônes de l’encadré', remove: 'Retirer l’icône' },
	comments: {
		placeholder: 'Ajouter un commentaire…',
		reply: 'Répondre…',
		post: 'Envoyer',
		cancel: 'Annuler',
		resolve: 'Résoudre',
		reopen: 'Rouvrir',
		delete: 'Supprimer',
		resolvedBy: (name) => `Résolu par ${name}`,
		showResolved: (count) => `Résolus (${count})`,
		hideResolved: 'Masquer les résolus',
		you: 'Vous',
		when: (at) =>
			Number.isFinite(at)
				? new Intl.DateTimeFormat('fr', {
						day: 'numeric',
						month: 'short',
						hour: '2-digit',
						minute: '2-digit'
					}).format(at)
				: '',
		failed: 'Le commentaire n’a pas pu être enregistré. Réessayez.'
	},
	table: {
		insertAbove: 'Insérer au-dessus',
		insertBelow: 'Insérer en dessous',
		insertLeft: 'Insérer à gauche',
		insertRight: 'Insérer à droite',
		moveUp: 'Monter',
		moveDown: 'Descendre',
		moveLeft: 'Déplacer à gauche',
		moveRight: 'Déplacer à droite',
		deleteRow: 'Supprimer la ligne',
		deleteColumn: 'Supprimer la colonne',
		addRow: 'Ajouter une ligne',
		addColumn: 'Ajouter une colonne',
		rowMenu: 'Options de la ligne',
		columnMenu: 'Options de la colonne'
	},
	equation: {
		editor: 'Équation',
		placeholder: 'E = mc^2',
		done: 'Terminé'
	},
	pageLink: {
		menu: 'Pages',
		searching: 'Recherche…',
		noResults: 'Aucun résultat'
	},
	trigger: { menu: 'Suggestions', searching: 'Recherche…', noResults: 'Aucun résultat' },
	starter: {
		page: 'Page',
		content: 'Contenu de la page',
		addIcon: 'Ajouter une icône',
		addCover: 'Ajouter une couverture',
		changeCover: 'Changer la couverture',
		reposition: 'Repositionner',
		savePosition: 'Enregistrer la position',
		positionHint: 'Faites glisser l’image, ou utilisez les flèches haut et bas',
		coverMenu: 'Options de la couverture',
		icon: 'Icône de la page',
		iconMenu: 'Options de l’icône',
		emojis: 'Émojis',
		upload: 'Importer',
		uploading: 'Importation…',
		link: 'Lien',
		linkPlaceholder: 'Collez le lien d’une image…',
		apply: 'Appliquer',
		remove: 'Retirer',
		close: 'Fermer',
		title: 'Titre de la page',
		untitled: 'Sans titre',
		properties: 'Propriétés de la page',
		addProperty: 'Ajouter une propriété',
		hideProperty: (name: string) => `Masquer ${name}`,
		showProperty: (name: string) => `Afficher ${name}`,
		hiddenProperties: (count: number) =>
			count === 1 ? '1 propriété masquée' : `${count} propriétés masquées`,
		search: 'Rechercher…',
		noOptions: 'Aucune option',
		pickDate: 'Choisir une date',
		clear: 'Effacer',
		empty: 'Vide',
		pick: 'Choisir une option',
		yes: 'Oui',
		no: 'Non',
		removeValue: (name: string) => `Retirer ${name}`
	}
};
