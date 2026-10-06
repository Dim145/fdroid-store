"""Official F-Droid category taxonomy.

The IDs mirror fdroiddata's ``config/categories.yml``. They matter beyond
cosmetics: F-Droid 2.0 maps each of these exact IDs to a built-in icon and to
one of twelve "meta-category" groups on its Discover screen
(``ui/categories/CategoryItem.kt``); any other ID is shown with a generic icon
under "Miscellaneous". The client ignores category icons shipped by a repo,
but it does display our localized ``name`` and searches our ``description``.

The English and French texts below are our own wording — only the IDs (and
the client-side grouping, kept for the admin UI) come from upstream.
"""
from __future__ import annotations

from dataclasses import dataclass

DEFAULT_LOCALE = "en-US"


@dataclass(frozen=True)
class OfficialCategory:
    # F-Droid 2.0 Discover group: communication, device, games, health,
    # interests, media, misc, network, productivity, storage, tools, wallets.
    group: str
    name_fr: str
    description_en: str
    description_fr: str


_C = OfficialCategory

OFFICIAL_CATEGORIES: dict[str, OfficialCategory] = {
    "AI Chat": _C(
        "tools", "Assistant IA",
        "Chatbots, AI assistants and LLM front-ends",
        "Chatbots, assistants IA et interfaces pour modèles de langage",
    ),
    "Action Game": _C(
        "games", "Jeu d'action",
        "Fast-paced action, racing and platform games",
        "Jeux d'action, de course et de plateforme",
    ),
    "Alarm Clock": _C(
        "tools", "Réveil",
        "Wake-up alarms at a set time",
        "Alarmes et réveils à heure fixe",
    ),
    "Ambient Sound": _C(
        "media", "Sons d'ambiance",
        "Ambient sounds and background noise",
        "Sons d'ambiance et bruits de fond",
    ),
    "App Manager": _C(
        "device", "Gestion des applications",
        "Inspect and manage installed apps and their permissions",
        "Gérer les applications installées et leurs autorisations",
    ),
    "App Store & Updater": _C(
        "device", "Magasin d'applications",
        "Find, install and update apps",
        "Trouver, installer et mettre à jour des applications",
    ),
    "Audiobook": _C(
        "media", "Livres audio",
        "Listen to and organise audiobooks",
        "Écouter et organiser des livres audio",
    ),
    "Battery": _C(
        "device", "Batterie",
        "Monitor battery health and power usage",
        "Surveiller la batterie et la consommation d'énergie",
    ),
    "Board Game": _C(
        "games", "Jeu de plateau",
        "Chess, go and other board games",
        "Échecs, go et autres jeux de plateau",
    ),
    "Bookmark": _C(
        "storage", "Marque-pages",
        "Save and organise links and reading lists",
        "Enregistrer et organiser des liens et des listes de lecture",
    ),
    "Browser": _C(
        "network", "Navigateur",
        "Web browsers",
        "Navigateurs web",
    ),
    "Calculator": _C(
        "tools", "Calculatrice",
        "Basic, scientific and programmer calculators",
        "Calculatrices simples, scientifiques ou pour développeurs",
    ),
    "Calendar & Agenda": _C(
        "productivity", "Calendrier et agenda",
        "Events, appointments and planners",
        "Événements, rendez-vous et agendas",
    ),
    "Camera": _C(
        "device", "Appareil photo",
        "Take photos and videos, view IP cameras",
        "Photos, vidéos et caméras IP",
    ),
    "Card Game": _C(
        "games", "Jeu de cartes",
        "Solitaire and other card games",
        "Réussites et autres jeux de cartes",
    ),
    "Cast": _C(
        "media", "Diffusion",
        "Stream to TVs and speakers (DLNA, UPnP, AirPlay…)",
        "Diffuser vers TV et enceintes (DLNA, UPnP, AirPlay…)",
    ),
    "Casual Game": _C(
        "games", "Jeu occasionnel",
        "Simple games for short sessions",
        "Jeux simples pour de courtes parties",
    ),
    "Clock": _C(
        "productivity", "Horloge",
        "Show the current time",
        "Afficher l'heure",
    ),
    "Cloud Storage & File Sync": _C(
        "storage", "Stockage en ligne et synchronisation",
        "Back up, sync and access files remotely",
        "Sauvegarder, synchroniser et consulter ses fichiers à distance",
    ),
    "Code & Forge": _C(
        "productivity", "Code et forge",
        "Git clients and source-code hosting",
        "Clients Git et hébergement de code source",
    ),
    "Connectivity": _C(
        "network", "Connectivité",
        "Wi-Fi, Bluetooth, mobile data and networking",
        "Wi-Fi, Bluetooth, données mobiles et réseau",
    ),
    "Contact": _C(
        "communication", "Contacts",
        "Address books and contact management",
        "Carnets d'adresses et gestion des contacts",
    ),
    "Covid": _C(
        "misc", "Covid",
        "COVID-19 tracing and information",
        "Traçage et informations sur la COVID-19",
    ),
    "DNS & Hosts": _C(
        "network", "DNS et hosts",
        "DNS resolvers, hosts files and ad blocking",
        "Résolveurs DNS, fichiers hosts et blocage des publicités",
    ),
    "Development": _C(
        "interests", "Développement",
        "Programming tools, IDEs and terminals",
        "Outils de programmation, IDE et terminaux",
    ),
    "Dice": _C(
        "games", "Dés et tirage au sort",
        "Dice and random pickers",
        "Dés et tirages au sort",
    ),
    "Diet": _C(
        "health", "Alimentation",
        "Track nutrition and calories",
        "Suivre son alimentation et ses calories",
    ),
    "Download": _C(
        "network", "Téléchargement",
        "Download managers and torrent clients",
        "Gestionnaires de téléchargement et clients torrent",
    ),
    "Draw": _C(
        "interests", "Dessin",
        "Sketching, painting and digital art",
        "Croquis, peinture et art numérique",
    ),
    "Ebook Reader": _C(
        "media", "Liseuse",
        "Read ebooks, EPUB and PDF files",
        "Lire des livres numériques, EPUB et PDF",
    ),
    "Educational Game": _C(
        "games", "Jeu éducatif",
        "Learn while playing, quizzes",
        "Apprendre en jouant, quiz",
    ),
    "Email": _C(
        "communication", "E-mail",
        "Email clients",
        "Clients de messagerie électronique",
    ),
    "Emergency Action": _C(
        "device", "Urgence",
        "Panic buttons and emergency actions",
        "Boutons d'alerte et actions d'urgence",
    ),
    "Emulator": _C(
        "games", "Émulateur",
        "Emulators for consoles and other systems",
        "Émulateurs de consoles et d'autres systèmes",
    ),
    "File Encryption & Vault": _C(
        "storage", "Chiffrement et coffre-fort",
        "Encrypt and hide private files",
        "Chiffrer et cacher des fichiers privés",
    ),
    "File Manager": _C(
        "storage", "Gestionnaire de fichiers",
        "Browse and manage files",
        "Parcourir et gérer des fichiers",
    ),
    "File Transfer": _C(
        "storage", "Transfert de fichiers",
        "Share files over the network, Bluetooth or peer-to-peer",
        "Partager des fichiers par le réseau, Bluetooth ou en pair-à-pair",
    ),
    "Finance Manager": _C(
        "wallets", "Gestion financière",
        "Budgets, expenses and accounts",
        "Budgets, dépenses et comptes",
    ),
    "Firewall": _C(
        "network", "Pare-feu",
        "Control which apps can access the network",
        "Contrôler l'accès des applications au réseau",
    ),
    "Flashlight": _C(
        "tools", "Lampe torche",
        "Use the camera flash as a torch",
        "Utiliser le flash comme lampe torche",
    ),
    "Forum": _C(
        "communication", "Forum",
        "Discussion boards and Q&A communities",
        "Forums de discussion et communautés de questions-réponses",
    ),
    "Gallery": _C(
        "storage", "Galerie",
        "View and organise photos and videos",
        "Afficher et organiser photos et vidéos",
    ),
    "Game Helper": _C(
        "games", "Aide aux jeux",
        "Companions, score keepers and game timers",
        "Compagnons, compteurs de points et minuteurs de jeu",
    ),
    "Graphics": _C(
        "interests", "Graphisme",
        "Image editing and visual design",
        "Retouche d'images et création graphique",
    ),
    "Habit Tracker": _C(
        "health", "Suivi d'habitudes",
        "Build routines and track streaks",
        "Créer des routines et suivre ses séries",
    ),
    "Health Manager": _C(
        "health", "Suivi de santé",
        "Weight, heart rate, cycles and other health data",
        "Poids, fréquence cardiaque, cycles et autres données de santé",
    ),
    "Icon Pack": _C(
        "device", "Pack d'icônes",
        "Icon sets for launchers",
        "Jeux d'icônes pour lanceurs",
    ),
    "Internet": _C(
        "network", "Internet",
        "Online services and web tools",
        "Services en ligne et outils web",
    ),
    "Inventory": _C(
        "tools", "Inventaire",
        "Catalogue and track physical items",
        "Cataloguer et suivre des objets",
    ),
    "Keyboard & IME": _C(
        "device", "Clavier",
        "Keyboards and input methods",
        "Claviers et méthodes de saisie",
    ),
    "Launcher": _C(
        "device", "Lanceur",
        "Home screen replacements",
        "Écrans d'accueil alternatifs",
    ),
    "Local Media Player": _C(
        "media", "Lecteur multimédia local",
        "Play audio and video files stored on the device",
        "Lire les fichiers audio et vidéo de l'appareil",
    ),
    "Location Tracker & Sharer": _C(
        "tools", "Partage de position",
        "Share and follow a live location",
        "Partager et suivre une position en temps réel",
    ),
    "Lyrics": _C(
        "interests", "Paroles",
        "Find and display song lyrics",
        "Trouver et afficher les paroles de chansons",
    ),
    "Market & Price": _C(
        "wallets", "Marchés et prix",
        "Prices, exchange rates and stocks",
        "Prix, taux de change et marchés boursiers",
    ),
    "Medication": _C(
        "health", "Médicaments",
        "Medication reminders and tracking",
        "Rappels et suivi des médicaments",
    ),
    "Meditation": _C(
        "health", "Méditation",
        "Meditation, mindfulness and breathing",
        "Méditation, pleine conscience et respiration",
    ),
    "Mental Health": _C(
        "health", "Santé mentale",
        "Mood tracking and mental well-being",
        "Suivi de l'humeur et bien-être psychologique",
    ),
    "Messaging": _C(
        "communication", "Messagerie",
        "Instant messaging and chat",
        "Messagerie instantanée et discussion",
    ),
    "Multimedia": _C(
        "media", "Multimédia",
        "Audio, video and other media",
        "Audio, vidéo et autres médias",
    ),
    "Music Practice Tool": _C(
        "interests", "Pratique musicale",
        "Tuners, metronomes and practice aids",
        "Accordeurs, métronomes et aides à la pratique",
    ),
    "Navigation": _C(
        "tools", "Navigation",
        "Maps, GPS and route planning",
        "Cartes, GPS et itinéraires",
    ),
    "Network Analyzer": _C(
        "network", "Analyse réseau",
        "Diagnose Wi-Fi and network connections",
        "Diagnostiquer le Wi-Fi et les connexions réseau",
    ),
    "News": _C(
        "interests", "Actualités",
        "News, articles and RSS feeds",
        "Actualités, articles et flux RSS",
    ),
    "Note": _C(
        "storage", "Notes",
        "Note-taking apps",
        "Prise de notes",
    ),
    "Notification": _C(
        "device", "Notifications",
        "Manage, log or forward notifications",
        "Gérer, journaliser ou transférer les notifications",
    ),
    "OCR": _C(
        "tools", "OCR",
        "Document scanning and text recognition",
        "Numérisation de documents et reconnaissance de texte",
    ),
    "Online Media Player": _C(
        "media", "Lecteur multimédia en ligne",
        "Stream music, video and live content",
        "Musique, vidéo et contenus en direct en streaming",
    ),
    "Party Game": _C(
        "games", "Jeu à plusieurs",
        "Multiplayer and party games",
        "Jeux multijoueurs et jeux d'ambiance",
    ),
    "Pass Wallet": _C(
        "wallets", "Cartes et billets",
        "Boarding passes, tickets and loyalty cards",
        "Cartes d'embarquement, billets et cartes de fidélité",
    ),
    "Password & 2FA": _C(
        "device", "Mots de passe et 2FA",
        "Password managers and two-factor authenticators",
        "Gestionnaires de mots de passe et authentification à deux facteurs",
    ),
    "Phone & SMS": _C(
        "communication", "Téléphone et SMS",
        "Dialers, call management and text messages",
        "Numérotation, gestion des appels et SMS",
    ),
    "Platformer Game": _C(
        "games", "Jeu de plateforme",
        "Platform and side-scrolling games",
        "Jeux de plateforme et à défilement horizontal",
    ),
    "Podcast": _C(
        "media", "Podcasts",
        "Subscribe to and play podcasts",
        "S'abonner à des podcasts et les écouter",
    ),
    "Public Transport": _C(
        "tools", "Transports en commun",
        "Timetables and journey planners",
        "Horaires et calcul d'itinéraires",
    ),
    "Push": _C(
        "device", "Notifications push",
        "Push message delivery",
        "Distribution de messages push",
    ),
    "Puzzle Game": _C(
        "games", "Jeu de réflexion",
        "Puzzles, sudoku and memory games",
        "Casse-têtes, sudoku et jeux de mémoire",
    ),
    "Radio": _C(
        "media", "Radio",
        "Live broadcast and internet radio",
        "Radio en direct et webradios",
    ),
    "Reading": _C(
        "media", "Lecture",
        "Articles, read-it-later and long-form reading",
        "Articles, lecture différée et lecture au long cours",
    ),
    "Recipe Manager": _C(
        "interests", "Recettes",
        "Store and discover recipes",
        "Conserver et découvrir des recettes",
    ),
    "Recorder": _C(
        "tools", "Enregistreur",
        "Record audio, calls or the screen",
        "Enregistrer le son, les appels ou l'écran",
    ),
    "Religion": _C(
        "interests", "Religion",
        "Prayer times, scriptures and spiritual practice",
        "Heures de prière, textes sacrés et pratique spirituelle",
    ),
    "Remote Access": _C(
        "network", "Accès à distance",
        "Control computers and servers remotely (SSH, VNC, RDP)",
        "Contrôler ordinateurs et serveurs à distance (SSH, VNC, RDP)",
    ),
    "Remote Controller": _C(
        "tools", "Télécommande",
        "Remotes for TVs and smart-home devices",
        "Télécommandes pour TV et objets connectés",
    ),
    "Role-Playing Game": _C(
        "games", "Jeu de rôle",
        "RPGs and roguelikes",
        "Jeux de rôle et roguelikes",
    ),
    "Schedule": _C(
        "productivity", "Programme d'événement",
        "Schedules for conferences and events",
        "Programmes de conférences et d'événements",
    ),
    "Science & Education": _C(
        "interests", "Sciences et éducation",
        "Learning, reference and education",
        "Apprentissage, ouvrages de référence et éducation",
    ),
    "Security": _C(
        "device", "Sécurité",
        "Protect your device and data",
        "Protéger son appareil et ses données",
    ),
    "Shooter Game": _C(
        "games", "Jeu de tir",
        "Shooting games",
        "Jeux de tir",
    ),
    "Shopping List": _C(
        "tools", "Liste de courses",
        "Shopping and to-buy lists",
        "Listes de courses et d'achats",
    ),
    "Social Network": _C(
        "communication", "Réseau social",
        "Social media and microblogging",
        "Réseaux sociaux et microblogage",
    ),
    "Speech Recognizer": _C(
        "tools", "Reconnaissance vocale",
        "Speech-to-text and voice input",
        "Transcription de la parole et saisie vocale",
    ),
    "Sport Game": _C(
        "games", "Jeu de sport",
        "Sports games",
        "Jeux de sport",
    ),
    "Sports & Health": _C(
        "health", "Sport et santé",
        "Fitness, well-being and sports",
        "Forme, bien-être et sport",
    ),
    "Stopwatch": _C(
        "tools", "Chronomètre",
        "Measure elapsed time and laps",
        "Mesurer un temps écoulé et des tours",
    ),
    "Strategy Game": _C(
        "games", "Jeu de stratégie",
        "Strategy and simulation games",
        "Jeux de stratégie et de simulation",
    ),
    "System": _C(
        "device", "Système",
        "System tools and device settings",
        "Outils système et réglages de l'appareil",
    ),
    "Task": _C(
        "productivity", "Tâches",
        "To-do lists and task managers",
        "Listes de tâches et gestionnaires de tâches",
    ),
    "Text Editor": _C(
        "productivity", "Éditeur de texte",
        "Plain-text and Markdown editors",
        "Éditeurs de texte brut et Markdown",
    ),
    "Text Encryption": _C(
        "tools", "Chiffrement de texte",
        "Encrypt and decrypt text",
        "Chiffrer et déchiffrer du texte",
    ),
    "Text to Speech": _C(
        "device", "Synthèse vocale",
        "Text-to-speech engines",
        "Moteurs de synthèse vocale",
    ),
    "Theming": _C(
        "device", "Personnalisation",
        "Themes, fonts and look-and-feel",
        "Thèmes, polices et apparence",
    ),
    "Time Tracker": _C(
        "productivity", "Suivi du temps",
        "Track time spent on activities",
        "Suivre le temps passé sur des activités",
    ),
    "Timer": _C(
        "productivity", "Minuteur",
        "Countdowns and interval timers",
        "Comptes à rebours et minuteurs par intervalles",
    ),
    "Translation & Dictionary": _C(
        "tools", "Traduction et dictionnaire",
        "Translate text and look up words",
        "Traduire du texte et chercher des mots",
    ),
    "Unit Convertor": _C(
        "tools", "Conversion d'unités",
        "Convert units and currencies",
        "Convertir des unités et des devises",
    ),
    "VPN & Proxy": _C(
        "network", "VPN et proxy",
        "VPNs, proxies and censorship circumvention",
        "VPN, proxys et contournement de la censure",
    ),
    "Visual Novel": _C(
        "games", "Roman visuel",
        "Story-driven visual novels",
        "Romans visuels interactifs",
    ),
    "Voice & Video Chat": _C(
        "communication", "Appels audio et vidéo",
        "Voice and video calls, VoIP",
        "Appels audio et vidéo, VoIP",
    ),
    "Volume": _C(
        "media", "Volume",
        "Control volume settings",
        "Contrôler le volume",
    ),
    "Wallet": _C(
        "wallets", "Portefeuille",
        "Payment and cryptocurrency wallets",
        "Portefeuilles de paiement et de cryptomonnaies",
    ),
    "Wallpaper": _C(
        "device", "Fond d'écran",
        "Static and live wallpapers",
        "Fonds d'écran fixes et animés",
    ),
    "Weather": _C(
        "tools", "Météo",
        "Forecasts and weather conditions",
        "Prévisions et conditions météo",
    ),
    "Word Game": _C(
        "games", "Jeu de lettres",
        "Crosswords and word games",
        "Mots croisés et jeux de lettres",
    ),
    "Workout": _C(
        "health", "Entraînement",
        "Exercise routines and training logs",
        "Programmes d'exercices et suivi d'entraînement",
    ),
    "Writing": _C(
        "productivity", "Écriture",
        "Word processing, journaling and long-form writing",
        "Traitement de texte, journal et écriture",
    ),
}

# Seeded on first boot (and re-added if missing, like the previous list).
# Every entry is an official ID so it gets an icon + group in F-Droid 2.0.
# The legacy defaults ``Games``, ``Money``, ``Time`` and ``Misc`` are gone
# upstream (split into genres / finer categories) — existing rows are left
# alone and flagged as "custom" in the admin UI so they can be merged.
DEFAULT_CATEGORY_IDS: tuple[str, ...] = (
    "Browser",
    "Calendar & Agenda",
    "Casual Game",
    "Clock",
    "Connectivity",
    "Development",
    "Email",
    "File Manager",
    "Finance Manager",
    "Graphics",
    "Internet",
    "Messaging",
    "Multimedia",
    "Navigation",
    "Note",
    "Password & 2FA",
    "Phone & SMS",
    "Puzzle Game",
    "Reading",
    "Science & Education",
    "Security",
    "Sports & Health",
    "System",
    "Task",
    "Theming",
    "VPN & Proxy",
    "Writing",
)


def official(category_id: str) -> OfficialCategory | None:
    return OFFICIAL_CATEGORIES.get(category_id)


def localized_names(category_id: str) -> dict[str, str]:
    """Index-v2 ``name`` for a category: the ID doubles as the English name
    (exactly like fdroiddata), plus our French label for official IDs."""
    names = {DEFAULT_LOCALE: category_id}
    entry = OFFICIAL_CATEGORIES.get(category_id)
    if entry is not None:
        names["fr"] = entry.name_fr
    return names


def localized_descriptions(category_id: str, custom: str | None = None) -> dict[str, str]:
    """Index-v2 ``description``. An admin-written description wins for the
    default locale; official IDs fall back to (and add French from) the
    catalogue. Empty dict when there is nothing to say."""
    entry = OFFICIAL_CATEGORIES.get(category_id)
    out: dict[str, str] = {}
    english = (custom or "").strip() or (entry.description_en if entry else "")
    if english:
        out[DEFAULT_LOCALE] = english
    if entry is not None:
        out["fr"] = entry.description_fr
    return out
