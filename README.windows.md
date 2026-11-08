# Lattice pour Windows

Portage communautaire de [leo1oel/lattice](https://github.com/leo1oel/lattice), version 0.15.8. L’interface React, les éditeurs, la bibliothèque, les annotations, les modèles et le moteur Tauri proviennent du projet original. Ce dépôt contient les adaptations Windows, et ne représente pas une version officielle de son auteur.

## Installation

1. Télécharger l’installateur `Lattice-Windows-0.15.8-r2-setup.exe` depuis les Releases de ce dépôt.
2. Lancer l’installateur pour votre compte Windows. Il propose l’installation de Microsoft WebView2 si nécessaire.
3. Pour compiler les documents, installer [TeX Live pour Windows](https://tug.org/texlive/windows.html), avec `latexmk`, puis redémarrer Lattice. Une installation MiKTeX avec `latexmk` et Perl fonctionne également, mais TeX Live est la distribution utilisée pour la validation.
4. Ouvrir un dossier ou le tutoriel intégré, puis compiler.

Windows x64, à partir de Windows 10 version 1809 ; Windows 11 recommandé. Les premières utilisations des outils bibliographiques peuvent télécharger leurs environnements Python avec le `uv` inclus. Les fonctions Git et certains outils de conversion des articles nécessitent Git pour Windows. L’application ne contient aucun abonnement ni modèle IA.

Le binaire communautaire n’est pas signé par un certificat Windows. Les mises à jour se téléchargent manuellement depuis ce dépôt.

## Adaptations

- Installateur NSIS français/anglais, pour le compte courant.
- Ouverture, sauvegarde atomique, renommage, suppression et historique via des dossiers ouverts sous Windows.
- Refus des chemins hors projet, flux NTFS alternatifs et noms de périphériques Windows.
- Identité des fichiers par volume et index NTFS ; lecture partielle et export des PDF.
- Double-clic de barre de titre pour agrandir/restaurer et F11 pour entrer/sortir du plein écran ; minimum de fenêtre adapté aux écrans Windows avec mise à l’échelle.
- Terminal PowerShell réel avec ConPTY, redimensionnement, entrées/sorties et arrêt des processus.
- Recherche des exécutables `.exe`, `.cmd` et `.bat`, de TeX Live et MiKTeX.
- URI de fichiers Windows et Unicode pour TexLab.
- Node, uv/uvx et bibtex-tidy inclus ; moteur Open Slide préparé pour Windows.
- Secrets enregistrés via le Gestionnaire d’identification Windows.

## Export Word éditable

Dans la palette de commandes (Ctrl+K), chercher **Export Word…**, puis choisir un fichier `.docx`. Les modifications ouvertes sont sauvegardées avant la conversion du document LaTeX principal du projet. Pandoc est inclus dans l’installateur Windows ; sur les autres plateformes, installer Pandoc séparément.

Le DOCX contient du texte éditable, des titres, des équations Word, les images compatibles et les citations/bibliographies que Pandoc peut convertir. Il convient aux commentaires et au suivi des modifications des encadrants dans Word. Vérifier le document face au PDF avant envoi : pagination, polices, macros personnalisées, références croisées, TikZ, figures PDF et mises en page complexes peuvent différer ou être omis. Les avertissements du convertisseur sont affichés. Les modifications et commentaires ajoutés dans Word ne sont pas réimportés dans LaTeX.

## Limites connues

L’agent Synara intégré reste désactivé. Le projet original exige un bac à sable macOS empêchant l’agent de modifier directement les bibliographies `.bib`. Cette garantie n’a pas encore d’équivalent dans ce portage. Les fonctions de relecture et de révision qui dépendent de cet agent sont donc indisponibles. Claude Code, Codex et d’autres CLI peuvent être lancés normalement dans le panneau Terminal, avec leurs propres installations et connexions.

Le moteur de prévisualisation optionnel rtex reste limité aux Mac Apple Silicon. La compilation normale par latexmk et l’affichage PDF sont conservés. L’installation automatique de TeX et des paquets macOS n’est pas proposée sur Windows : utiliser TeX Live Manager ou MiKTeX Console.

Les licences des composants d’origine restent applicables : tldraw fonctionne avec son filigrane sans clé de production et Trellis est réservé à un usage non commercial sans licence de son auteur. Voir LICENSE, NOTICE et THIRD_PARTY_NOTICES.md.

## Compilation et validation

Sur Windows x64, avec Node 22, pnpm 10.13.1, Rust stable et les prérequis Tauri (Visual Studio C++ Build Tools et WebView2) :

```powershell
pnpm install --frozen-lockfile
pnpm build:windows
```

La préparation des ressources vérifie les sommes SHA-256 de Node et uv avant extraction. L’installateur se trouve dans `src-tauri/target/release/bundle/nsis/`.

Le workflow `.github/workflows/windows.yml` compile le moteur sur Windows, exécute les tests de fichiers Windows, construit l’interface et l’installateur. Le script de contrôle de bout en bout installe le `.exe`, attend la compilation du tutoriel en PDF, contrôle trois agrandissements/restaurations ainsi que F11/Échap, demande une recompilation et exécute une commande PowerShell via ConPTY. Il surveille l’apparition de consoles externes. Consulter le résultat du workflow : la présence du script ne garantit pas que tous ces contrôles ont réussi. Les captures et journaux sont conservés comme artefacts.
