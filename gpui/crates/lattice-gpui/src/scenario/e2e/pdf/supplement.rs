//! The second root document the PDF checks build and read.

/// Twelve pages: a link to section 9, a web link, and a link to a file and
/// one to an app's own scheme (neither may open) on the first, the word
/// "zebracorn" on pages 2, 4 and 6 and "zebracorns" on page 8, and a
/// sentence on page 10 the rebuild check rewrites with the same letters.
/// Before the first heading, a comment block pdfLaTeX skips: it hides a
/// heading from the outline, and its wide characters (three bytes each) must
/// not move the lines of the headings after it.
pub(super) const SUPPLEMENT: &str = r"\documentclass{article}
\usepackage{hyperref}
\usepackage{verbatim}
\begin{document}
\begin{comment}
中文注释：这一段不会排版，大纲也不读它。
\section{Hidden}
\end{comment}
\section{Overview}
Selectable sentence here. See Section~\ref{sec:target} and \url{https://example.org}.
Never opened: \href{file:///System/Applications/Calculator.app}{Fileanchor} and \href{lattice-test://x}{Schemeanchor}.
\newpage
\section{Two} A zebracorn appears.
\newpage
\section{Three} Plain text.
\newpage
\section{Four} Another zebracorn appears.
\newpage
\section{Five} Plain text.
\newpage
\section{Six} A third zebracorn appears.
\newpage
\section{Seven} Plain text.
\newpage
\section{Eight} Many zebracorns appear.
\newpage
\section{Target}\label{sec:target} The link lands here.
\newpage
\section{Ten} Swap target ten.
\newpage
\section{Eleven} Plain text.
\newpage
\section{Twelve} The end.
\end{document}
";
