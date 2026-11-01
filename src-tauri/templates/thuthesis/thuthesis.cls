%%
%% This is file `thuthesis.cls',
%% generated with the docstrip utility.
%%
%% The original source files were:
%%
%% thuthesis.dtx  (with options: `cls')
%% 
%% This is a generated file.
%% 
%% Copyright (C) 2005-2026 by Tsinghua University TUNA Association <tuna@tsinghua.edu.cn>
%% 
%% This work may be distributed and/or modified under the
%% conditions of the LaTeX Project Public License, either version 1.3c
%% of this license or (at your option) any later version.
%% The latest version of this license is in
%%    https://www.latex-project.org/lppl.txt
%% and version 1.3c or later is part of all distributions of LaTeX
%% version 2008 or later.
%% 
%% To produce the documentation run the original source files ending with `.dtx'
%% through LaTeX.
%% 
\NeedsTeXFormat{LaTeX2e}[2017/04/15]
\ProvidesClass{thuthesis}
[2026/05/26 7.7.1 Tsinghua University Thesis Template]
\newcommand\thu@error[1]{%
  \ClassError{thuthesis}{#1}{}%
}
\newcommand\thu@warning[1]{%
  \ClassWarning{thuthesis}{#1}%
}
\newcommand\thu@debug[1]{%
  \typeout{Package thuthesis Info: #1}%
}
\newcommand\thu@patch@error[1]{%
  \thu@error{Failed to patch command \protect#1}%
}
\newcommand\thu@deprecate[2]{%
  \def\thu@@tmp{#2}%
  \thu@warning{%
    The #1 is deprecated%
    \ifx\thu@@tmp\@empty\else
      . Use #2 instead%
    \fi
  }%
}
\newcommand\thu@replace@with@error[1]{%
  \expandafter\def\csname #1\endcsname{%
    \thu@error{%
      \expandafter\protect\csname #1\endcsname\space can only be used once.
      \MessageBreak
      Please remove the duplicate call%
    }%
  }%
}
\@ifl@t@r\fmtversion{2017/04/15}{}{
  \thu@error{%
    TeX Live 2017 or later version is required to compile this document%
  }
}
\RequirePackage{iftex}
\ifXeTeX\else
  \ifLuaTeX\else
    \thu@error{XeLaTeX or LuaLaTeX is required to compile this document}
  \fi
\fi
\InputIfFileExists{thuthesis-pdf-test-config.tex}{}{
  \InputIfFileExists{thuthesis-log-test-config.tex}{}{}
}
\hyphenation{Thu-Thesis}
\def\thuthesis{ThuThesis}
\def\version{7.7.1}
\RequirePackage{kvdefinekeys}
\RequirePackage{kvsetkeys}
\RequirePackage{kvoptions}
\SetupKeyvalOptions{
  family=thu,
  prefix=thu@,
  setkeys=\kvsetkeys}
\let\thu@setup@hook\@empty
\newcommand\thusetup[1]{%
  \let\thu@setup@hook\@empty
  \kvsetkeys{thu}{#1}%
  \thu@setup@hook
}
\newcommand\thu@define@key[1]{%
  \kvsetkeys{thu@key}{#1}%
}
\kv@set@family@handler{thu@key}{%
  \@namedef{thu@#1@@name}{#1}%
  \def\thu@@default{}%
  \def\thu@@choices{}%
  \kv@define@key{thu@value}{name}{%
    \@namedef{thu@#1@@name}{##1}%
  }%
  \@namedef{thu@#1@@check}{}%
  \@namedef{thu@#1@@code}{}%
  \kv@define@key{thu@value}{choices}{%
    \def\thu@@choices{##1}%
    \@namedef{thu@#1@@reset}{}%
    \@namedef{thu@#1@@check}{%
      \@ifundefined{%
        ifthu@\@nameuse{thu@#1@@name}@\@nameuse{thu@\@nameuse{thu@#1@@name}}%
      }{%
        \thu@error{Invalid value "#1 = \@nameuse{thu@\@nameuse{thu@#1@@name}}"}%
      }%
      \@nameuse{thu@#1@@reset}%
      \@nameuse{thu@\@nameuse{thu@#1@@name}@\@nameuse{thu@\@nameuse{thu@#1@@name}}true}%
    }%
  }%
  \kv@define@key{thu@value}{default}{%
    \def\thu@@default{##1}%
  }%
  \kvsetkeys{thu@value}{#2}%
  \@namedef{thu@\@nameuse{thu@#1@@name}}{}%
  \kv@set@family@handler{thu@choice}{%
    \ifx\thu@@default\@empty
      \def\thu@@default{##1}%
    \fi
    \expandafter\newif\csname ifthu@\@nameuse{thu@#1@@name}@##1\endcsname
    \expandafter\g@addto@macro\csname thu@#1@@reset\endcsname{%
      \@nameuse{thu@\@nameuse{thu@#1@@name}@##1false}%
    }%
  }%
  \kvsetkeys@expandafter{thu@choice}{\thu@@choices}%
  \expandafter\let\csname thu@\@nameuse{thu@#1@@name}\endcsname\thu@@default
  \expandafter\ifx\csname thu@\@nameuse{thu@#1@@name}\endcsname\@empty\else
    \@nameuse{thu@#1@@check}%
  \fi
  \kv@define@key{thu}{#1}{%
    \@namedef{thu@\@nameuse{thu@#1@@name}}{##1}%
    \@nameuse{thu@#1@@check}%
    \@nameuse{thu@#1@@code}%
  }%
}
\newcommand\thu@option@hook[2]{%
  \expandafter\g@addto@macro\csname thu@#1@@code\endcsname{#2}%
}
\thu@define@key{
  thesis-type = {
    name = thesis@type,
    choices = {
      thesis,
      proposal,
    },
    default = thesis,
  },
  degree = {
    choices = {
      bachelor,
      master,
      doctor,
      postdoc,
    },
    default = doctor,
  },
  degree-type = {
    choices = {
      academic,
      professional,
    },
    name = degree@type,
  },
  main-language = {
    name = main@language,
    choices = {
      chinese,
      english,
    },
  },
  language = {
    choices = {
      chinese,
      english,
    },
  },
  system = {
    choices = {
      auto,
      mac,
      unix,
      windows,
    },
    default = auto,
  },
  fontset = {
    choices = {
      auto,
      windows,
      mac,
      ubuntu,
      fandol,
      none,
    },
    default = auto,
  },
  font = {
    choices = {
      auto,
      times,
      termes,
      stix,
      xits,
      libertinus,
      newcm,
      lm,
      newtx,
      none,
    },
    default = auto,
  },
  cjk-font = {
    name = cjk@font,
    choices = {
      auto,
      windows,
      windows-local,
      mac,
      mac-word,
      noto,
      fandol,
      none,
    },
    default = auto,
  },
  windows-font-dir = {
    name = windows@font@dir,
    default = {.},
  },
  math-font = {
    name = math@font,
    choices = {
      auto,
      stix,
      xits,
      libertinus,
      newcm,
      lm,
      newtx,
      none,
    },
    default = auto,
  },
  math-style = {
    name = math@style,
    choices = {
      GB,
      ISO,
      TeX,
    },
  },
  uppercase-greek = {
    name = uppercase@greek,
    choices = {
      italic,
      upright,
    },
  },
  less-than-or-equal = {
    name = leq,
    choices = {
      slanted,
      horizontal,
    },
  },
  integral = {
    choices = {
      upright,
      slanted,
    },
  },
  integral-limits = {
    name = integral@limits,
    choices = {
      true,
      false,
    },
  },
  partial = {
    choices = {
      upright,
      italic,
    },
  },
  math-ellipsis = {
    name = math@ellipsis,
    choices = {
      centered,
      lower,
      AMS,
    },
  },
  real-part = {
    name = real@part,
    choices = {
      roman,
      fraktur,
    },
  },
  output = {
    choices = {
      print,
      electronic,
    },
    default = print,
  },
  eqn-paren-style = {
    name = eqn@paren@style,
    choices = {
      full,
      half,
    }
  },
  style-override = {
    name    = style@override,
    choices = {
      none,
      schwarzman,
    },
  },
  footnote-numbering = {
    name    = footnote@numbering,
    choices = {
      page,
      chapter,
      global,
    },
  },
  footnote-style = {
    name    = footnote@style,
    choices = {
      circled,
      plain,
    },
  },
  figure-numbering = {
    name    = figure@numbering,
    choices = {
      chapter,
      global,
    },
  },
  table-numbering = {
    name    = table@numbering,
    choices = {
      chapter,
      global,
    },
  },
  equation-numbering = {
    name    = equation@numbering,
    choices = {
      chapter,
      global,
    },
  },
}
\newif\ifthu@degree@graduate
\newcommand\thu@set@graduate{%
  \thu@degree@graduatefalse
  \ifthu@degree@doctor
    \thu@degree@graduatetrue
  \fi
  \ifthu@degree@master
    \thu@degree@graduatetrue
  \fi
}
\thu@set@graduate
\thu@option@hook{degree}{%
  \thu@set@graduate
}
\DeclareBoolOption[false]{openright}
\DeclareComplementaryOption{openany}{openright}
\DeclareBoolOption[true]{raggedbottom}
\DeclareDefaultOption{\PassOptionsToClass{\CurrentOption}{ctexbook}}
\ProcessKeyvalOptions*
\ifthu@openright
  \PassOptionsToClass{openright}{book}
\else
  \PassOptionsToClass{openany}{book}
\fi
\PassOptionsToPackage{no-math}{fontspec}
\ifthu@style@override@schwarzman
  \thusetup{
    footnote-numbering = global,
    footnote-style     = plain,
    figure-numbering   = global,
    table-numbering    = global,
    equation-numbering = global,
  }
\fi
\thu@option@hook{style-override}{\thu@error{%
  The 'style-override' option is only valid in class options.%
}}%
\thu@option@hook{footnote-numbering}{\thu@error{%
  The 'footnote-numbering' option is only valid in class options.%
}}%
\ifthu@footnote@numbering@page
  \PassOptionsToPackage{perpage}{footmisc}%
\fi
\LoadClass[a4paper,UTF8,zihao=-4,scheme=plain,fontset=none]{ctexbook}[2017/04/01]
\RequirePackage{etoolbox}
\RequirePackage{filehook}
\RequirePackage{xparse}
\RequirePackage{geometry}%
\RequirePackage{fancyhdr}
\RequirePackage{titletoc}
\RequirePackage{notoccite}
\RequirePackage{amsmath}
\RequirePackage{graphicx}
\RequirePackage[labelformat=simple]{subcaption}
\RequirePackage{pdfpages}
\includepdfset{fitpaper=true}
\AtEndPreamble{
  \ifx\tikzifexternalizing\@undefined\else
    \tikzifexternalizing{
      \renewcommand*\includepdf[2][]{}
    }{}
  \fi
}
\RequirePackage[shortlabels]{enumitem}
\RequirePackage{environ}
\ifthu@raggedbottom
  \RequirePackage[bottom,hang]{footmisc}
  \raggedbottom
\else
  \RequirePackage[hang]{footmisc}
\fi
\ifXeTeX
  \RequirePackage{xeCJKfntef}
\else
  \RequirePackage{ulem}
\fi
\RequirePackage{array}
\RequirePackage{booktabs}
\RequirePackage{url}
\AtEndPreamble{
  \@ifpackageloaded{biblatex}{}{
    \@ifpackageloaded{apacite}{}{
      \RequirePackage{natbib}
    }
  }
}
\AtEndOfPackageFile*{natbib}{
  \@ifpackageloaded{apacite}{}{
    \RequirePackage{bibunits}
  }
}
\newcommand\thu@package@conflict[2]{%
  \AtEndOfPackageFile*{#1}{%
    \AtBeginOfPackageFile*{#2}{%
      \thu@error{The "#2" package is incompatible with "#1"}%
    }%
  }%
}
\thu@package@conflict{biblatex}{bibunits}
\thu@package@conflict{biblatex}{chapterbib}
\thu@package@conflict{biblatex}{cite}
\thu@package@conflict{biblatex}{multibib}
\thu@package@conflict{biblatex}{natbib}

\thu@package@conflict{bibunits}{biblatex}
\thu@package@conflict{bibunits}{chapterbib}
\thu@package@conflict{bibunits}{multibib}

\thu@package@conflict{unicode-math}{amscd}
\thu@package@conflict{unicode-math}{amsfonts}
\thu@package@conflict{unicode-math}{amssymb}
\thu@package@conflict{unicode-math}{bbm}
\thu@package@conflict{unicode-math}{bm}
\thu@package@conflict{unicode-math}{eucal}
\thu@package@conflict{unicode-math}{eufrak}
\thu@package@conflict{unicode-math}{mathrsfs}
\thu@package@conflict{unicode-math}{newtxmath}
\thu@package@conflict{unicode-math}{upgreek}

\thu@package@conflict{natbib}{biblatex}
\thu@package@conflict{natbib}{cite}

\thu@package@conflict{newtxmath}{amsfonts}
\thu@package@conflict{newtxmath}{amssymb}
\thu@package@conflict{newtxmath}{unicode-math}
\thu@package@conflict{newtxmath}{upgreek}
\AtBeginOfPackageFile*{amsthm}{
  \@ifpackageloaded{newtxmath}{
    \thu@error{The "amsthm" package should be loaded before setting "newtxmath"}
  }{}
}%
\geometry{
  paper          = a4paper,  % 210 * 297mm
  marginparwidth = 2cm,
  marginparsep   = 0.5cm,
}
\newcommand\thu@set@geometry{%
  \ifthu@degree@bachelor
    \geometry{
      margin     = 3cm,
      footskip   = 1.5cm,
    }%
  \else
    \geometry{
      margin     = 3cm,
      headheight = 2.7cm,
      headsep    = 0.3cm,
      footskip   = 0.8cm,
    }%
  \fi
}
\thu@set@geometry
\thu@option@hook{degree}{\thu@set@geometry}
\thu@option@hook{output}{\thu@set@geometry}
\thusetup{main-language=\thu@language}%
\let\thu@main@language\thu@language
\thu@option@hook{language}{%
  \ifx\@begindocumenthook\@undefined\else
    \thusetup{main-language=\thu@language}%
    \let\thu@main@language\thu@language
  \fi
}
\newcommand\thu@reset@main@language{%
  \thusetup{language = \thu@main@language}%
  \let\thu@language\thu@main@language
}
\newcommand\thu@set@chapter@names{%
  \ifthu@degree@bachelor
    \def\thu@statement@name{声明}%
  \else
    \def\thu@statement@name{声\hspace{1em}明}%
  \fi
  \ifthu@main@language@chinese
    \def\listfigurename{插图清单}%
    \def\listtablename{附表清单}%
    \def\thu@list@figure@table@name{插图和附表清单}%
    \def\thu@list@algorithm@name{算法清单}%
    \def\thu@denotation@name{符号和缩略语说明}%
    \def\thu@comments@name{指导教师评语}%
    \def\bibname{参考文献}%
    \def\appendixname{附录}%
    \def\indexname{索引}%
    \def\thu@resolution@name{答辩委员会决议书}%
    \ifthu@degree@bachelor
      \def\contentsname{目录}%
      \def\thu@acknowledgements@name{致谢}%
      \def\listequationname{公式索引}%
      \def\thu@resume@name{在学期间参加课题的研究成果}%
    \else
      \def\listequationname{公式清单}%
      \def\thu@acknowledgements@name{致\quad 谢}%
      \ifthu@degree@graduate
        \def\contentsname{目\quad 录}%
        \def\thu@resume@name{个人简历、在学期间完成的相关学术成果}%
      \else  % degree = postdoc
        \def\contentsname{目\qquad 次}%
        \def\thu@denotation@name{符号表}%
        \def\thu@resume@name{个人简历、发表的学术论文与科研成果}%
      \fi
    \fi
  \else
    \ifthu@main@language@english
      \def\thu@comments@name{Comments from Thesis Supervisor}%
      \def\thu@resolution@name{Resolution of Thesis Defense Committee}%
      \def\indexname{Index}%
      \ifthu@degree@bachelor
        \def\contentsname{CONTENTS}%
        \def\listfigurename{FIGURES}%
        \def\listtablename{TABLES}%
        \def\thu@list@figure@table@name{FIGURES AND TABLES}%
        \def\thu@list@algorithm@name{ALGORITHMS}%
        \def\listequationname{EQUATIONS}%
        \def\thu@denotation@name{ABBREVIATIONS}%
        \def\bibname{REFERENCES}%
        \def\appendixname{APPENDIX}%
        \def\thu@acknowledgements@name{ACKNOWLEDGEMENTS}%
        \def\thu@resume@name{PUBLICATIONS}%
      \else
        \def\contentsname{Table of Contents}%
        \def\listfigurename{List of Figures}%
        \def\listtablename{List of Tables}%
        \def\thu@list@figure@table@name{List of Figures and Tables}%
        \def\thu@list@algorithm@name{List of Algorithms}%
        \def\listequationname{List of Equations}%
        \def\thu@denotation@name{List of Symbols and Acronyms}%
        \def\bibname{References}%
        \def\appendixname{Appendix}%
        \def\thu@acknowledgements@name{Acknowledgements}%
        \def\thu@resume@name{Resume}%
      \fi
    \fi
  \fi
}
\thu@set@chapter@names
\thu@option@hook{degree}{\thu@set@chapter@names}
\thu@option@hook{main-language}{\thu@set@chapter@names}
\newcommand\thu@set@names{%
  \ifthu@language@chinese
    \ctexset{
      figurename = 图,
      tablename  = 表,
    }%
    \def\thu@algorithm@name{算法}%
    \def\thu@equation@name{公式}%
    \def\thu@assumption@name{假设}%
    \def\thu@definition@name{定义}%
    \def\thu@proposition@name{命题}%
    \def\thu@lemma@name{引理}%
    \def\thu@theorem@name{定理}%
    \def\thu@axiom@name{公理}%
    \def\thu@corollary@name{推论}%
    \def\thu@exercise@name{练习}%
    \def\thu@example@name{例}%
    \def\thu@remark@name{注释}%
    \def\thu@problem@name{问题}%
    \def\thu@conjecture@name{猜想}%
    \def\thu@proof@name{证明}%
    \def\thu@theorem@separator{：}%
  \else
    \ifthu@language@english
      \ctexset{
        figurename = {Figure},
        tablename  = {Table},
      }%
      \def\thu@algorithm@name{Algorithm}%
      \def\thu@equation@name{Equation}%
      \def\thu@assumption@name{Assumption}%
      \def\thu@definition@name{Definition}%
      \def\thu@proposition@name{Proposition}%
      \def\thu@lemma@name{Lemma}%
      \def\thu@theorem@name{Theorem}%
      \def\thu@axiom@name{Axiom}%
      \def\thu@corollary@name{Corollary}%
      \def\thu@exercise@name{Exercise}%
      \def\thu@example@name{Example}%
      \def\thu@remark@name{Remark}%
      \def\thu@problem@name{Problem}%
      \def\thu@conjecture@name{Conjecture}%
      \def\thu@proof@name{Proof}%
      \def\thu@theorem@separator{: }%
    \fi
  \fi
}
\thu@set@names
\thu@option@hook{language}{\thu@set@names}
\ifLuaTeX
  % ctex 将带圈数字 U+2460–U+2473 归入字符范围 3（ALchar），这里改回范围 6（JAchar）
  \ltjdefcharrange{6}{"2460-"2473, "2605}
\else
  \ifXeTeX
    \xeCJKDeclareCharClass{CJK}{"2460 -> "2473, "2605}
  \fi
\fi
\newcommand\thu@set@punctuations{%
  \ifthu@language@chinese
    \ifLuaTeX
      \ltjsetparameter{jacharrange={+9}}
    \else
      \ifXeTeX
        \xeCJKDeclareCharClass{FullLeft}{"2018, "201C}%
        \xeCJKDeclareCharClass{FullRight}{
          "00B7, "2019, "201D, "2013, "2014, "2025, "2026, "2E3A,
        }%
      \fi
    \fi
  \else
    \ifthu@language@english
      \ifLuaTeX
        \ltjsetparameter{jacharrange={-9}}
      \else
        \ifXeTeX
          \xeCJKDeclareCharClass{HalfLeft}{"2018, "201C}%
          \xeCJKDeclareCharClass{HalfRight}{
            "00B7, "2019, "201D, "2013, "2014, "2025, "2026, "2E3A,
          }%
        \fi
      \fi
    \fi
  \fi
}
\thu@set@punctuations
\thu@option@hook{language}{\thu@set@punctuations}
\renewcommand\normalsize{%
  \@setfontsize\normalsize{12bp}{20bp}%
  \abovedisplayskip 6bp%
  \abovedisplayshortskip 6bp%
  \belowdisplayshortskip 6bp%
  \belowdisplayskip \abovedisplayskip
}
\normalsize
\ifx\MakeRobust\@undefined \else
    \MakeRobust\normalsize
\fi
\def\thu@def@fontsize#1#2{%
  \expandafter\newcommand\csname #1\endcsname[1][1.3]{%
    \fontsize{#2}{##1\dimexpr #2}\selectfont}}
\thu@def@fontsize{chuhao}{42bp}
\thu@def@fontsize{xiaochu}{36bp}
\thu@def@fontsize{yihao}{26bp}
\thu@def@fontsize{xiaoyi}{24bp}
\thu@def@fontsize{erhao}{22bp}
\thu@def@fontsize{xiaoer}{18bp}
\thu@def@fontsize{sanhao}{16bp}
\thu@def@fontsize{xiaosan}{15bp}
\thu@def@fontsize{sihao}{14bp}
\thu@def@fontsize{xiaosi}{12bp}
\thu@def@fontsize{wuhao}{10.5bp}
\thu@def@fontsize{xiaowu}{9bp}
\thu@def@fontsize{liuhao}{7.5bp}
\thu@def@fontsize{xiaoliu}{6.5bp}
\thu@def@fontsize{qihao}{5.5bp}
\thu@def@fontsize{bahao}{5bp}
\ifthu@system@auto
  \IfFileExists{/System/Library/Fonts/Menlo.ttc}{
    \thusetup{system = mac}
  }{
    \IfFileExists{/dev/null}{
      \IfFileExists{null:}{
        \thusetup{system = windows}
      }{
        \thusetup{system = unix}
      }
    }{
      \thusetup{system = windows}
    }
  }
  \thu@debug{Detected system: \thu@system}
\fi
\newcommand\thu@mac@word@font@dir{%
  /Applications/Microsoft Word.app/Contents/Resources/DFonts%
}
\ifthu@fontset@auto
  \ifthu@system@windows
    \thusetup{fontset = windows}
  \else
    \IfFontExistsTF{SimSun}{
      \thusetup{fontset = windows}
    }{
      \IfFileExists{\thu@windows@font@dir/Simsun.ttc}{
        \thusetup{fontset = windows, cjk-font = windows-local}
      }{
        \IfFileExists{\thu@mac@word@font@dir/Simsun.ttc}{
          \thusetup{fontset = windows, cjk-font = mac-word}
        }{
          \ifthu@system@mac
            \thusetup{fontset = mac}
          \else
            \IfFontExistsTF{Noto Serif CJK SC}{
              \thusetup{fontset = ubuntu}
            }{
              \thusetup{fontset = fandol}
            }
          \fi
        }
      }
    }
  \fi
  \thu@debug{Detected fontset: \thu@fontset}
\fi
\newcommand\thu@set@font{%
  \@nameuse{thu@set@font@\thu@font}%
}
\thu@option@hook{font}{\thu@set@font}
\newcommand\thu@set@font@auto{%
  \ifthu@font@auto
    \ifthu@fontset@windows
      \thusetup{font=times}%
    \else
      \ifthu@fontset@mac
        \thusetup{font=times}%
      \else
        \thusetup{font=termes}%
      \fi
    \fi
  \fi
}
\thu@option@hook{math-font}{\g@addto@macro\thu@setup@hook{\thu@set@font@auto}}
\AtBeginOfPackageFile*{siunitx}{\thu@set@font@auto}
\AtEndPreamble{\thu@set@font@auto}
\newcommand\thu@set@font@times{%
  \setmainfont{Times New Roman}%
  \setsansfont{Arial}%
  \ifthu@fontset@mac
    \setmonofont{Menlo}[Scale = MatchLowercase]%
  \else
    \setmonofont{Courier New}[Scale = MatchLowercase]%
  \fi
}
\newcommand\thu@set@font@termes{%
  \setmainfont{texgyretermes}[
    Extension      = .otf,
    UprightFont    = *-regular,
    BoldFont       = *-bold,
    ItalicFont     = *-italic,
    BoldItalicFont = *-bolditalic,
  ]%
  \thu@set@texgyre@sans@mono
}
\newcommand\thu@set@texgyre@sans@mono{%
  \setsansfont{texgyreheros}[
    Extension      = .otf,
    UprightFont    = *-regular,
    BoldFont       = *-bold,
    ItalicFont     = *-italic,
    BoldItalicFont = *-bolditalic,
  ]%
  \setmonofont{texgyrecursor}[
    Extension      = .otf,
    UprightFont    = *-regular,
    BoldFont       = *-bold,
    ItalicFont     = *-italic,
    BoldItalicFont = *-bolditalic,
    Scale          = MatchLowercase,
    Ligatures      = CommonOff,
  ]%
}
\let\thu@font@family@stix\@empty
\newcommand\thu@set@stix@names{%
  \ifx\thu@font@family@stix\@empty
    \IfFontExistsTF{STIXTwoText-Regular.otf}{%
      \gdef\thu@font@family@stix{STIXTwoText}%
      \gdef\thu@font@name@stix@math{STIXTwoMath-Regular}%
    }{%
      \gdef\thu@font@family@stix{STIX2Text}%
      \gdef\thu@font@name@stix@math{STIX2Math}%
    }%
  \fi
}
\newcommand\thu@set@font@stix{%
  \thu@set@stix@names
  \setmainfont{\thu@font@family@stix}[
    Extension      = .otf,
    UprightFont    = *-Regular,
    BoldFont       = *-Bold,
    ItalicFont     = *-Italic,
    BoldItalicFont = *-BoldItalic,
  ]%
  \thu@set@texgyre@sans@mono
}
\let\thu@font@family@xits\@empty
\newcommand\thu@set@xits@names{%
  \ifx\thu@font@family@xits\@empty
    \IfFontExistsTF{XITSMath-Regular.otf}{%
      \gdef\thu@font@family@xits{XITS}%
      \gdef\thu@font@style@xits@rm{Regular}%
      \gdef\thu@font@style@xits@bf{Bold}%
      \gdef\thu@font@style@xits@it{Italic}%
      \gdef\thu@font@style@xits@bfit{BoldItalic}%
      \gdef\thu@font@name@xits@math{XITSMath-Regular}%
    }{%
      \gdef\thu@font@family@xits{xits}%
      \gdef\thu@font@style@xits@rm{regular}%
      \gdef\thu@font@style@xits@bf{bold}%
      \gdef\thu@font@style@xits@it{italic}%
      \gdef\thu@font@style@xits@bfit{bolditalic}%
      \gdef\thu@font@name@xits@math{xits-math}%
    }%
  \fi
}
\newcommand\thu@set@font@xits{%
  \thu@set@xits@names
  \setmainfont{\thu@font@family@xits}[
    Extension      = .otf,
    UprightFont    = *-\thu@font@style@xits@rm,
    BoldFont       = *-\thu@font@style@xits@bf,
    ItalicFont     = *-\thu@font@style@xits@it,
    BoldItalicFont = *-\thu@font@style@xits@bfit,
  ]%
  \thu@set@texgyre@sans@mono
}
\let\thu@font@family@libertinus\@empty
\newcommand\thu@set@libertinus@names{%
  \ifx\thu@font@family@libertinus\@empty
    \IfFontExistsTF{LibertinusSerif-Regular.otf}{%
      \gdef\thu@font@family@libertinus@serif{LibertinusSerif}%
      \gdef\thu@font@family@libertinus@sans{LibertinusSans}%
      \gdef\thu@font@name@libertinus@math{LibertinusMath-Regular}%
      \gdef\thu@font@style@libertinus@rm{Regular}%
      \gdef\thu@font@style@libertinus@bf{Bold}%
      \gdef\thu@font@style@libertinus@it{Italic}%
      \gdef\thu@font@style@libertinus@bfit{BoldItalic}%
    }{%
      \gdef\thu@font@family@libertinus@serif{libertinusserif}%
      \gdef\thu@font@family@libertinus@sans{libertinussans}%
      \gdef\thu@font@name@libertinus@math{libertinusmath-regular}%
      \gdef\thu@font@style@libertinus@rm{regular}%
      \gdef\thu@font@style@libertinus@bf{bold}%
      \gdef\thu@font@style@libertinus@it{italic}%
      \gdef\thu@font@style@libertinus@bfit{bolditalic}%
    }%
  \fi
}
\newcommand\thu@set@font@libertinus{%
  \thu@set@libertinus@names
  \setmainfont{\thu@font@family@libertinus@serif}[
    Extension      = .otf,
    UprightFont    = *-\thu@font@style@libertinus@rm,
    BoldFont       = *-\thu@font@style@libertinus@bf,
    ItalicFont     = *-\thu@font@style@libertinus@it,
    BoldItalicFont = *-\thu@font@style@libertinus@bfit,
  ]%
  \setsansfont{\thu@font@family@libertinus@sans}[
    Extension      = .otf,
    UprightFont    = *-\thu@font@style@libertinus@rm,
    BoldFont       = *-\thu@font@style@libertinus@bf,
    ItalicFont     = *-\thu@font@style@libertinus@it,
  ]%
  \setmonofont{lmmonolt10}[
    Extension      = .otf,
    UprightFont    = *-regular,
    BoldFont       = *-bold,
    ItalicFont     = *-oblique,
    BoldItalicFont = *-boldoblique,
  ]%
}
\newcommand\thu@set@font@newcm{%
  \setmainfont{NewCM10}[
    Extension      = .otf,
    UprightFont    = *-Book,
    BoldFont       = *-Bold,
    ItalicFont     = *-BookItalic,
    BoldItalicFont = *-BoldItalic,
  ]%
  \setsansfont{NewCMSans10}[
    Extension         = .otf,
    UprightFont       = *-Book,
    BoldFont          = *-Bold,
    ItalicFont        = *-BookOblique,
    BoldItalicFont    = *-BoldOblique,
  ]%
  \setmonofont{NewCMMono10}[
    Extension           = .otf,
    UprightFont         = *-Book,
    ItalicFont          = *-BookItalic,
    BoldFont            = *-Bold,
    BoldItalicFont      = *-BoldOblique,
  ]%
}
\newcommand\thu@set@font@lm{%
  \setmainfont{lmroman10}[
    Extension      = .otf,
    UprightFont    = *-regular,
    BoldFont       = *-bold,
    ItalicFont     = *-italic,
    BoldItalicFont = *-bolditalic,
  ]%
  \setsansfont{lmsans10}[
    Extension      = .otf,
    UprightFont    = *-regular,
    BoldFont       = *-bold,
    ItalicFont     = *-oblique,
    BoldItalicFont = *-boldoblique,
  ]%
  \setmonofont{lmmonolt10}[
    Extension      = .otf,
    UprightFont    = *-regular,
    BoldFont       = *-bold,
    ItalicFont     = *-oblique,
    BoldItalicFont = *-boldoblique,
  ]%
}
\newcommand\thu@set@font@newtx{%
  \RequirePackage{newtxtext}%
}
\ifthu@cjk@font@auto
  \ifthu@fontset@mac
    \thusetup{cjk-font = mac}
  \else
    \ifthu@fontset@windows
      \IfFontExistsTF{SimSun}{
        \thusetup{cjk-font = windows}
      }{
        \IfFileExists{\thu@windows@font@dir/Simsun.ttc}{
          \thusetup{cjk-font = windows-local}
        }{
          \IfFileExists{\thu@mac@word@font@dir/Simsun.ttc}{
            \thusetup{cjk-font = mac-word}
          }{
            \thu@error{Cannot find "SimSun" font}
          }
        }
      }
    \else
      \ifthu@fontset@ubuntu
        \thusetup{cjk-font = noto}
      \else
        \thusetup{cjk-font = fandol}
      \fi
    \fi
  \fi
  \thu@debug{Detected CJK font: \thu@cjk@font}
\fi
\newcommand\thu@set@cjk@font@windows{%
  \setCJKmainfont{SimSun}[
    AutoFakeBold = 3,
    ItalicFont   = KaiTi,
  ]%
  \setCJKsansfont{SimHei}[AutoFakeBold = 3]%
  \setCJKmonofont{FangSong}%
  \setCJKfamilyfont{zhsong}{SimSun}[AutoFakeBold = 3]%
  \setCJKfamilyfont{zhhei}{SimHei}[AutoFakeBold = 3]%
  \setCJKfamilyfont{zhkai}{KaiTi}%
  \setCJKfamilyfont{zhfs}{FangSong}%
}
\@namedef{thu@set@cjk@font@windows-local}{%
  \IfFileExists{\thu@windows@font@dir/Kaiti.ttf}{
    \setCJKmainfont{SimSun}[%
      Path         = \thu@windows@font@dir/,
      Extension    = .ttc,
      AutoFakeBold = 3,
      ItalicFont   = Kaiti,
      ItalicFeatures = {Extension = .ttf},
    ]%
    \setCJKmonofont{Fangsong}[
      Path         = \thu@windows@font@dir/,
      Extension    = .ttf,
    ]%
    \setCJKfamilyfont{zhkai}{Kaiti}[
      Path         = \thu@windows@font@dir/,
      Extension    = .ttf,
    ]%
    \setCJKfamilyfont{zhfs}{Fangsong}[
      Path         = \thu@windows@font@dir/,
      Extension    = .ttf,
    ]%
  }{
    \setCJKmainfont{SimSun}[%
      Path         = \thu@windows@font@dir/,
      Extension    = .ttc,
      AutoFakeBold = 3,
      ItalicFont   = Simkai,
      ItalicFeatures = {Extension = .ttf},
    ]%
    \setCJKmonofont{Simfang}[
      Path         = \thu@windows@font@dir/,
      Extension    = .ttf,
    ]%
    \setCJKfamilyfont{zhkai}{Simkai}[
      Path         = \thu@windows@font@dir/,
      Extension    = .ttf,
    ]%
    \setCJKfamilyfont{zhfs}{Simfang}[
      Path         = \thu@windows@font@dir/,
      Extension    = .ttf,
    ]%
  }
  \setCJKsansfont{SimHei}[%
    Path         = \thu@windows@font@dir/,
    Extension    = .ttf,
    AutoFakeBold = 3,
  ]%
  \setCJKfamilyfont{zhsong}{SimSun}[%
    Path         = \thu@windows@font@dir/,
    Extension    = .ttc,
    AutoFakeBold = 3,
  ]%
  \setCJKfamilyfont{zhhei}{SimHei}[%
    Path         = \thu@windows@font@dir/,
    Extension    = .ttf,
    AutoFakeBold = 3,
  ]%
}
\@namedef{thu@set@cjk@font@mac-word}{%
  \let\thu@windows@font@dir\thu@mac@word@font@dir
  \@nameuse{thu@set@cjk@font@windows-local}%
}
\newcommand\thu@set@cjk@font@mac{%
  \defaultCJKfontfeatures{}%
  \setCJKmainfont{Songti SC}[
    UprightFont    = * Light,
    BoldFont       = * Bold,
    ItalicFont     = Kaiti SC Regular,
    BoldItalicFont = Kaiti SC Bold,
  ]%
  \setCJKsansfont{Heiti SC}[
    UprightFont    = * Light,
    BoldFont       = * Medium,
  ]%
  \setCJKmonofont{STFangsong}
  \setCJKfamilyfont{zhsong}{Songti SC}[
    UprightFont    = * Light,
    BoldFont       = * Bold,
  ]%
  \setCJKfamilyfont{zhhei}{Heiti SC}[
    UprightFont    = * Light,
    BoldFont       = * Medium,
  ]%
  \setCJKfamilyfont{zhfs}{STFangsong}%
  \setCJKfamilyfont{zhkai}{Kaiti SC}[
    UprightFont    = * Regular,
    BoldFont       = * Bold,
  ]%
  \setCJKfamilyfont{zhli}{Baoli SC}%
  \setCJKfamilyfont{zhyuan}{Yuanyi SC}[
    UprightFont    = * Light,
    BoldFont       = * Bold,
  ]%
}
\newcommand\thu@set@cjk@font@noto{%
  \defaultCJKfontfeatures{}%
  \setCJKmainfont{Noto Serif CJK SC}[
    UprightFont    = * Light,
    BoldFont       = * Bold,
    ItalicFont     = FandolKai-Regular,
    ItalicFeatures = {Extension = .otf},
    Script         = CJK,
  ]%
  \setCJKsansfont{Noto Sans CJK SC}[
    BoldFont       = * Medium,
    Script         = CJK,
  ]%
  \setCJKmonofont{Noto Sans Mono CJK SC}[
    Script         = CJK,
  ]%
  \setCJKfamilyfont{zhsong}{Noto Serif CJK SC}[
    UprightFont    = * Light,
    UprightFont    = * Bold,
    Script         = CJK,
  ]%
  \setCJKfamilyfont{zhhei}{Noto Sans CJK SC}[
    BoldFont       = * Medium,
    Script         = CJK,
  ]%
  \setCJKfamilyfont{zhfs}{FandolFang}[
    Extension      = .otf,
    UprightFont    = *-Regular,
  ]%
  \setCJKfamilyfont{zhkai}{FandolKai}[
    Extension      = .otf,
    UprightFont    = *-Regular,
  ]%
}
\newcommand\thu@set@cjk@font@fandol{%
  \defaultCJKfontfeatures{}%
  \setCJKmainfont{FandolSong}[
    Extension   = .otf,
    UprightFont = *-Regular,
    BoldFont    = *-Bold,
    ItalicFont  = FandolKai-Regular,
    ItalicFeatures = {Extension = .otf},
  ]%
  \setCJKsansfont{FandolHei}[
    Extension   = .otf,
    UprightFont = *-Regular,
    BoldFont    = *-Bold,
  ]%
  \setCJKmonofont{FandolFang}[
    Extension   = .otf,
    UprightFont = *-Regular,
  ]%
  \setCJKfamilyfont{zhsong}{FandolSong}[
    Extension   = .otf,
    UprightFont = *-Regular,
    BoldFont    = *-Bold,
  ]%
  \setCJKfamilyfont{zhhei}{FandolHei}[
    Extension   = .otf,
    UprightFont = *-Regular,
    BoldFont    = *-Bold,
  ]%
  \setCJKfamilyfont{zhfs}{FandolFang}[
    Extension   = .otf,
    UprightFont = *-Regular,
  ]%
  \setCJKfamilyfont{zhkai}{FandolKai}[
    Extension   = .otf,
    UprightFont = *-Regular,
  ]%
}
\ifthu@cjk@font@none\else
  \providecommand\songti{\CJKfamily{zhsong}}
  \providecommand\heiti{\CJKfamily{zhhei}}
  \providecommand\fangsong{\CJKfamily{zhfs}}
  \providecommand\kaishu{\CJKfamily{zhkai}}
\fi
\newcommand\thu@set@cjk@font{%
  \@nameuse{thu@set@cjk@font@\thu@cjk@font}%
}
\thu@set@cjk@font
\thu@option@hook{cjk-font}{\thu@set@cjk@font}
\newcommand\thu@set@math@style{%
  \ifthu@math@style@TeX
    \thusetup{
      uppercase-greek    = upright,
      less-than-or-equal = horizontal,
      integral           = slanted,
      integral-limits    = false,
      partial            = italic,
      math-ellipsis      = AMS,
      real-part          = fraktur,
    }%
  \else
    \thusetup{
      uppercase-greek = italic,
      integral        = upright,
      partial         = upright,
      real-part       = roman,
    }%
    \ifthu@math@style@ISO
      \thusetup{
        less-than-or-equal = horizontal,
        integral-limits    = true,
        math-ellipsis      = lower,
      }%
    \else
      \ifthu@math@style@GB
        \thusetup{
          less-than-or-equal = slanted,
          integral-limits    = false,
          math-ellipsis      = centered,
        }%
      \fi
    \fi
  \fi
}
\ifthu@main@language@chinese
  \thusetup{math-style=GB}%
\else
  \thusetup{math-style=TeX}%
\fi
\thu@set@math@style
\thu@option@hook{math-style}{\thu@set@math@style}
\thu@option@hook{main-language}{%
  \ifthu@main@language@chinese
    \thusetup{math-style=GB}%
  \else
    \thusetup{math-style=TeX}%
  \fi
}
\newcommand\thu@set@unimath@leq{%
  \ifthu@leq@horizontal
    \ifx\@begindocumenthook\@undefined
      \let\le\thu@save@leq
      \let\ge\thu@save@geq
      \let\leq\thu@save@leq
      \let\geq\thu@save@geq
    \else
      \AtBeginDocument{%
        \let\le\thu@save@leq
        \let\ge\thu@save@geq
        \let\leq\thu@save@leq
        \let\geq\thu@save@geq
      }%
    \fi
  \else
    \ifthu@leq@slanted
      \ifx\@begindocumenthook\@undefined
        \let\le\leqslant
        \let\ge\geqslant
        \let\leq\leqslant
        \let\geq\geqslant
      \else
        \AtBeginDocument{%
          \let\le\leqslant
          \let\ge\geqslant
          \let\leq\leqslant
          \let\geq\geqslant
        }%
      \fi
    \fi
  \fi
}
\newcommand\thu@set@unimath@integral@limits{%
  \ifthu@integral@limits@true
    \removenolimits{%
      \int\iint\iiint\iiiint\oint\oiint\oiiint
      \intclockwise\varointclockwise\ointctrclockwise\sumint
      \intbar\intBar\fint\cirfnint\awint\rppolint
      \scpolint\npolint\pointint\sqint\intlarhk\intx
      \intcap\intcup\upint\lowint
    }%
  \else
    \addnolimits{%
      \int\iint\iiint\iiiint\oint\oiint\oiiint
      \intclockwise\varointclockwise\ointctrclockwise\sumint
      \intbar\intBar\fint\cirfnint\awint\rppolint
      \scpolint\npolint\pointint\sqint\intlarhk\intx
      \intcap\intcup\upint\lowint
    }%
  \fi
}
\newcommand\thu@set@unimath@ellipsis{%
  \ifthu@math@ellipsis@centered
    \DeclareRobustCommand\mathellipsis{\mathinner{\unicodecdots}}%
  \else
    \DeclareRobustCommand\mathellipsis{\mathinner{\unicodeellipsis}}%
  \fi
}
\newcommand\thu@set@unimath@real@part{%
  \ifthu@real@part@roman
    \AtBeginDocument{%
      \def\Re{\operatorname{Re}}%
      \def\Im{\operatorname{Im}}%
    }%
  \else
    \AtBeginDocument{%
      \let\Re\thu@save@Re
      \let\Im\thu@save@Im
    }%
  \fi
}
\newcommand\thu@set@unimath@style{%
  \ifthu@uppercase@greek@upright
    \unimathsetup{math-style = TeX}%
  \else
    \ifthu@uppercase@greek@italic
      \unimathsetup{math-style = ISO}%
    \fi
  \fi
  \ifthu@math@style@TeX
    \unimathsetup{bold-style = TeX}%
  \else
    \unimathsetup{bold-style = ISO}%
  \fi
  \thu@set@unimath@leq
  \thu@set@unimath@integral@limits
  \ifthu@partial@upright
    \unimathsetup{partial = upright}%
  \else
    \ifthu@partial@italic
      \unimathsetup{partial = italic}%
    \fi
  \fi
  \thu@set@unimath@ellipsis
  \thu@set@unimath@real@part
}
\newcommand\thu@qed{\rule{1ex}{1ex}}
\newcommand\thu@load@unimath{%
  \@ifpackageloaded{unicode-math}{}{%
    \RequirePackage{unicode-math}%
    \AtBeginDocument{%
      \let\thu@save@leq\leq
      \let\thu@save@geq\geq
      \let\thu@save@Re\Re
      \let\thu@save@Im\Im
    }%
    \DeclareRobustCommand\bm[1]{{\symbfit{##1}}}%
    \DeclareRobustCommand\boldsymbol[1]{{\symbfit{##1}}}%
    \newcommand\square{\mdlgwhtsquare}%
    \newcommand\blacksquare{\mdlgblksquare}%
    \AtBeginDocument{%
      \renewcommand\checkmark{\ensuremath{\symbol{"2713}}}%
    }%
    \renewcommand\thu@qed{\ensuremath{\QED}}%
  }%
}
\newcommand\thu@set@math@font@stix{%
  \thu@set@stix@names
  \setmathfont{\thu@font@name@stix@math}[
    Extension    = .otf,
    Scale        = MatchLowercase,
    StylisticSet = \thu@xits@integral@stylistic@set,
  ]%
  \setmathfont{\thu@font@name@stix@math}[
    Extension    = .otf,
    Scale        = MatchLowercase,
    StylisticSet = 1,
    range        = {scr,bfscr},
  ]%
}
\newcommand\thu@xits@integral@stylistic@set{%
  \ifthu@integral@upright
    8%
  \fi
}
\newcommand\thu@set@math@font@xits{%
  \thu@set@xits@names
  \setmathfont{\thu@font@name@xits@math}[
    Extension    = .otf,
    StylisticSet = \thu@xits@integral@stylistic@set,
  ]%
  \setmathfont{\thu@font@name@xits@math}[
    Extension    = .otf,
    StylisticSet = 1,
    range        = {cal,bfcal},
  ]%
}
\newcommand\thu@libertinus@integral@stylistic@set{%
  \ifthu@integral@slanted
    8%
  \fi
}
\newcommand\thu@set@math@font@libertinus{%
  \thu@set@libertinus@names
  \setmathfont{\thu@font@name@libertinus@math}[
    Extension    = .otf,
    StylisticSet = \thu@libertinus@integral@stylistic@set,
  ]%
}
\newcommand\thu@newcm@integral@stylistic@set{%
  \ifthu@integral@upright
    2%
  \fi
}
\newcommand\thu@set@math@font@newcm{%
  \setmathfont{NewCMMath-Book}[
    Extension    = .otf,
    StylisticSet = \thu@newcm@integral@stylistic@set,
  ]%
  \setmathfont{NewCMMath-Book}[
    Extension    = .otf,
    StylisticSet = 1,
    range        = {scr,bfscr},
  ]%
  \setmathrm{NewCM10}[
    Extension      = .otf,
    UprightFont    = *-Book,
    BoldFont       = *-Bold,
    ItalicFont     = *-BookItalic,
    BoldItalicFont = *-BoldItalic,
  ]%
  \setmathsf{NewCMSans10}[
    Extension         = .otf,
    UprightFont       = *-Book,
    BoldFont          = *-Bold,
    ItalicFont        = *-BookOblique,
    BoldItalicFont    = *-BoldOblique,
  ]%
  \setmathtt{NewCMMono10}[
    Extension           = .otf,
    UprightFont         = *-Book,
    ItalicFont          = *-BookItalic,
    BoldFont            = *-Bold,
    BoldItalicFont      = *-BoldOblique,
  ]%
}
\newcommand\thu@set@math@font@lm{%
  \setmathfont{latinmodern-math}[Extension=.otf]%
  \setmathrm{lmroman10}[
    Extension      = .otf,
    UprightFont    = *-regular,
    BoldFont       = *-bold,
    ItalicFont     = *-italic,
    BoldItalicFont = *-bolditalic,
  ]%
  \setmathsf{lmsans10}[
    Extension      = .otf,
    UprightFont    = *-regular,
    BoldFont       = *-bold,
    ItalicFont     = *-oblique,
    BoldItalicFont = *-boldoblique,
  ]%
  \setmathtt{lmmonolt10}[
    Extension      = .otf,
    UprightFont    = *-regular,
    BoldFont       = *-bold,
    ItalicFont     = *-oblique,
    BoldItalicFont = *-boldoblique,
  ]%
}
\newcommand\thu@set@math@font@newtx{%
  \ifthu@font@newtx\else
    \let\thu@save@encodingdefault\encodingdefault
    \let\thu@save@rmdefault\rmdefault
    \let\thu@save@sfdefault\sfdefault
    \let\thu@save@ttdefault\ttdefault
    \RequirePackage[T1]{fontenc}%
    \renewcommand{\rmdefault}{ntxtlf}%
    \renewcommand{\sfdefault}{qhv}%
    \renewcommand{\ttdefault}{ntxtt}%
  \fi
  \ifthu@uppercase@greek@italic
    \PassOptionsToPackage{slantedGreek}{newtxmath}%
  \fi
  \ifthu@integral@upright
    \PassOptionsToPackage{upint}{newtxmath}%
  \fi
  \RequirePackage{newtxmath}%
  \let\thu@save@leq\leq
  \let\thu@save@geq\geq
  \ifthu@leq@slanted
    \let\le\leqslant
    \let\ge\geqslant
    \let\leq\leqslant
    \let\geq\geqslant
  \fi
  \ifthu@integral@limits@true
    \let\ilimits@\displaylimits
  \fi
  \let\thu@save@partial\partial
  \ifthu@partial@upright
    \let\partial\uppartial
  \fi
  \ifthu@math@ellipsis@centered
    \DeclareRobustCommand\mathellipsis{\mathinner{\cdotp\cdotp\cdotp}}%
  \else
    \DeclareRobustCommand\mathellipsis{\mathinner{\ldotp\ldotp\ldotp}}%
  \fi
  \let\thu@save@Re\Re
  \let\thu@save@Im\Im
  \ifthu@real@part@roman
    \def\Re{\operatorname{Re}}%
    \def\Im{\operatorname{Im}}%
  \fi
  \RequirePackage{bm}%
  \ifthu@font@newtx\else
    \let\encodingdefault\thu@save@encodingdefault
    \let\rmdefault\thu@save@rmdefault
    \let\sfdefault\thu@save@sfdefault
    \let\ttdefault\thu@save@ttdefault
  \fi
  \DeclareRobustCommand\symup[1]{{\mathrm{##1}}}%
  \DeclareRobustCommand\symbf[1]{{\bm{##1}}}%
  \DeclareRobustCommand\symbfsf[1]{{\bm{\mathsf{##1}}}}%
  \let\increment\upDelta%
  \renewcommand\thu@qed{\openbox}%
}
\newcommand\thu@set@math@font{%
  \ifthu@math@font@none\else
    \ifthu@math@font@newtx
      \thu@set@math@font@newtx
    \else
      \thu@load@unimath
      \thu@set@unimath@style
      \@nameuse{thu@set@math@font@\thu@math@font}%
    \fi
  \fi
}
\thu@option@hook{math-font}{\g@addto@macro\thu@setup@hook{\thu@set@math@font}}
\newcommand\thu@set@math@font@auto{%
  \ifthu@math@font@auto
    \thusetup{math-font=xits}%
  \fi
}
\AtBeginOfPackageFile*{siunitx}{\thu@set@math@font@auto}
\AtEndPreamble{\thu@set@math@font@auto}
\def\cleardoublepage{%
  \clearpage
  \if@twoside
    \ifthu@output@print
      \ifodd\c@page
      \else
        \thispagestyle{empty}%
        \hbox{}%
        \newpage
        \if@twocolumn
          \hbox{}\newpage
        \fi
      \fi
    \fi
  \fi
}
\renewcommand\frontmatter{%
  \cleardoublepage
  \@mainmatterfalse
  \pagenumbering{Roman}%
}
\renewcommand\mainmatter{%
  \cleardoublepage
  \@mainmattertrue
  \pagenumbering{arabic}%
}
\renewcommand\backmatter{%
  \clearpage
  \@mainmatterfalse
  \thusetup{toc-depth = 0}%
}
\pagestyle{fancy}
\fancypagestyle{plain}{%
  \fancyhf{}%
  \renewcommand\footrulewidth{0pt}%
  \ifthu@degree@bachelor
    \renewcommand\headrulewidth{0pt}%
    \fancyfoot[C]{
      \ifthu@main@language@chinese
        \fontsize{10.5bp}{12.075bp}\selectfont
      \else
        \normalsize
      \fi
      \thepage
    }%
    \let\@mkboth\@gobbletwo
    \let\chaptermark\@gobble
  \else
    \renewcommand\headrulewidth{0.75bp}%
    \fancyhead[C]{%
      \wuhao
      \ifthu@main@language@chinese
        \leftmark
      \else
        \MakeUppercase{\leftmark}%
      \fi
      }%
    \fancyfoot[C]{\wuhao\thepage}%
    \let\@mkboth\markboth
    \def\chaptermark##1{%
      \markboth{%
        \CTEXifname{%
          \CTEXthechapter
          \ifthu@main@language@chinese
            \quad
          \else
            \space
          \fi
        }{}##1%
      }{}%
    }%
  \fi
  \let\sectionmark\@gobble
}
\pagestyle{plain}
\def\ps@chapter{}
\ctexset{chapter/pagestyle = chapter}
\ctexset{%
  punct=quanjiao,
}
\newcommand\thu@set@indent{%
  \ifthu@main@language@chinese
    \ctexset{autoindent=2}%
  \else
    \ifthu@degree@bachelor
      \ctexset{autoindent=0.8cm}%
    \else
      \ctexset{autoindent=0.74cm}%
    \fi
  \fi
}
\thu@set@indent
\thu@option@hook{degree}{\thu@set@indent}
\thu@option@hook{main-language}{\thu@set@indent}
\urlstyle{same}
\g@addto@macro\UrlBreaks{%
  \do0\do1\do2\do3\do4\do5\do6\do7\do8\do9%
  \do\A\do\B\do\C\do\D\do\E\do\F\do\G\do\H\do\I\do\J\do\K\do\L\do\M
  \do\N\do\O\do\P\do\Q\do\R\do\S\do\T\do\U\do\V\do\W\do\X\do\Y\do\Z
  \do\a\do\b\do\c\do\d\do\e\do\f\do\g\do\h\do\i\do\j\do\k\do\l\do\m
  \do\n\do\o\do\p\do\q\do\r\do\s\do\t\do\u\do\v\do\w\do\x\do\y\do\z
}
\Urlmuskip=0mu plus 0.1mu
\partopsep=\z@skip
\def\@listi{\leftmargin\leftmargini
            \parsep \z@skip
            \topsep \z@skip
            \itemsep\z@skip}
\let\@listI\@listi
\@listi
\def\@listii {\leftmargin\leftmarginii
              \labelwidth\leftmarginii
              \advance\labelwidth-\labelsep
              \topsep    \z@skip
              \parsep    \z@skip
              \itemsep   \z@skip}
\def\@listiii{\leftmargin\leftmarginiii
              \labelwidth\leftmarginiii
              \advance\labelwidth-\labelsep
              \topsep    \z@skip
              \parsep    \z@skip
              \partopsep \z@skip
              \itemsep   \z@skip}
\setlist{nosep}
\interfootnotelinepenalty=10000
\ifthu@footnote@numbering@global
  \@removefromreset{footnote}{chapter}%
\fi
\newcommand\thu@circled[1]{%
  \ifnum#1 >10\relax
    \thu@warning{%
      Too many footnotes in this page.
      Keep footnote less than 10%
    }%
  \fi
  {\symbol{\the\numexpr#1+"245F\relax}}%
}
\ifthu@footnote@style@circled
  \renewcommand{\thefootnote}{\thu@circled{\c@footnote}}%
  \renewcommand{\thempfootnote}{\thu@circled{\c@mpfootnote}}%
\else
  \renewcommand{\thefootnote}{\arabic{footnote}}%
  \renewcommand{\thempfootnote}{\arabic{mpfootnote}}%
\fi
\def\footnoterule{\vskip-3\p@\hrule\@width0.3\textwidth\@height0.4\p@\vskip2.6\p@}
\footnotemargin=13.5bp
\long\def\@makefntext#1{%
  \begingroup
    % 序号取消上标
    \def\@makefnmark{\hbox{\normalfont\@thefnmark}}%
    \xiaowu
    \ifFN@hangfoot
      \bgroup
      \setbox\@tempboxa\hbox{%
        \ifdim\footnotemargin>\z@
          \hb@xt@\footnotemargin{\@makefnmark\hss}%
        \else
          \@makefnmark
        \fi
      }%
      \leftmargin\wd\@tempboxa
      \rightmargin\z@
      \linewidth \columnwidth
      \advance \linewidth -\leftmargin
      \parshape \@ne \leftmargin \linewidth
      % \footnotesize
      \xiaowu
      \@setpar{{\@@par}}%
      \leavevmode
      \llap{\box\@tempboxa}%
      \parskip\hangfootparskip\relax
      \parindent\hangfootparindent\relax
    \else
      \parindent1em%
      \noindent
      \ifdim\footnotemargin>\z@
        \hb@xt@ \footnotemargin{\hss\@makefnmark}%
      \else
        \ifdim\footnotemargin=\z@
          \llap{\@makefnmark}%
        \else
          \llap{\hb@xt@ -\footnotemargin{\@makefnmark\hss}}%
        \fi
      \fi
    \fi
    \footnotelayout#1%
    \ifFN@hangfoot
      \par\egroup
    \fi
  \endgroup
}
\allowdisplaybreaks[4]
\newcommand\thu@put@parentheses[1]{%
  \ifthu@language@chinese
    \ifthu@eqn@paren@style@full
      \kern 0pt\relax
      （#1）%
    \else
      (#1)%
    \fi
  \else
    (#1)%
  \fi
}
\def\tagform@#1{%
  \maketag@@@{\thu@put@parentheses{\ignorespaces#1\unskip\@@italiccorr}}%
}
\DeclareRobustCommand{\eqref}[1]{%
  \ifthu@language@chinese
    \ifthu@eqn@paren@style@full
      \unskip
    \fi
  \fi
  \textup{\tagform@{\ref{#1}}}%
  \ifthu@language@chinese
    \ifthu@eqn@paren@style@full
      \ignorespaces
    \fi
  \fi
}
\def\fps@figure{htbp}
\def\fps@table{htbp}
\setlength{\floatsep}{12\p@ \@plus 2\p@ \@minus 2\p@}
\setlength{\textfloatsep}{12\p@ \@plus 2\p@ \@minus 2\p@}
\setlength{\intextsep}{12\p@ \@plus 2\p@ \@minus 2\p@}
\setlength{\@fptop}{0bp \@plus1.0fil}
\setlength{\@fpsep}{12bp \@plus2.0fil}
\setlength{\@fpbot}{0bp \@plus1.0fil}
\patchcmd{\@addtocurcol}%
  {\vskip \intextsep}%
  {\edef\save@first@penalty{\the\lastpenalty}\unpenalty
   \ifnum \lastpenalty = \@M  % hopefully the OR penalty
     \unpenalty
   \else
     \penalty \save@first@penalty \relax % put it back
   \fi
   \ifnum\outputpenalty <-\@Mii
     \addvspace\intextsep
     \vskip\parskip
   \else
     \addvspace\intextsep
   \fi}%
  {}{\thu@patch@error{\@addtocurcol}}
\patchcmd{\@addtocurcol}%
  {\vskip\intextsep \ifnum\outputpenalty <-\@Mii \vskip -\parskip\fi}%
  {\ifnum\outputpenalty <-\@Mii
     \aftergroup\vskip\aftergroup\intextsep
     \aftergroup\nointerlineskip
   \else
     \vskip\intextsep
   \fi}%
  {}{\thu@patch@error{\@addtocurcol}}
\patchcmd{\@getpen}{\@M}{\@Mi}
  {}{\thu@patch@error{\@getpen}}
\renewcommand{\textfraction}{0.15}
\renewcommand{\topfraction}{0.85}
\renewcommand{\bottomfraction}{0.65}
\renewcommand{\floatpagefraction}{0.60}
\thu@define@key{
  figure-number-separator = {
    name    = figure@number@separator,
    default = {.},
  },
  table-number-separator = {
    name    = table@number@separator,
    default = {.},
  },
  equation-number-separator = {
    name    = equation@number@separator,
    default = {.},
  },
  number-separator = {
    name    = number@separator,
    default = {.},
  },
}
\newcommand\thu@set@figure@numbering{%
  \ifthu@figure@numbering@chapter
    \@addtoreset{figure}{chapter}%
  \else
    \@removefromreset{figure}{chapter}%
  \fi
}
\thu@set@figure@numbering
\thu@option@hook{figure-numbering}{\thu@set@figure@numbering}
\renewcommand\thefigure{%
  \ifthu@figure@numbering@chapter
    \ifnum\c@chapter>\z@
      \thechapter
      \thu@figure@number@separator
    \fi
  \fi
  \@arabic\c@figure
}
\newcommand\thu@set@table@numbering{%
  \ifthu@table@numbering@chapter
    \@addtoreset{table}{chapter}%
  \else
    \@removefromreset{table}{chapter}%
  \fi
}
\thu@set@table@numbering
\thu@option@hook{table-numbering}{\thu@set@table@numbering}
\renewcommand\thetable{%
  \ifthu@table@numbering@chapter
    \ifnum\c@chapter>\z@
      \thechapter
      \thu@table@number@separator
    \fi
  \fi
  \@arabic\c@table
}
\newcommand\thu@set@equation@numbering{%
  \ifthu@equation@numbering@chapter
    \@addtoreset{equation}{chapter}%
  \else
    \@removefromreset{equation}{chapter}%
  \fi
}
\thu@set@equation@numbering
\thu@option@hook{equation-numbering}{\thu@set@equation@numbering}
\renewcommand\theequation{%
  \ifthu@equation@numbering@chapter
    \ifnum\c@chapter>\z@
      \thechapter
      \thu@equation@number@separator
    \fi
  \fi
  \@arabic\c@equation
}
\newcommand\thu@set@number@separator{%
  \let\thu@figure@number@separator\thu@number@separator
  \let\thu@table@number@separator\thu@number@separator
  \let\thu@equation@number@separator\thu@number@separator
}
\thu@option@hook{number-separator}{\thu@set@number@separator}
\DeclareCaptionFont{thu}{%
  \ifthu@degree@bachelor
    \fontsize{11bp}{15bp}\selectfont
  \else
    \ifthu@language@chinese
      \fontsize{11bp}{14.3bp}\selectfont
    \else
      \fontsize{11bp}{12.65bp}\selectfont
    \fi
  \fi
}
\captionsetup{
  font           = thu,
  labelsep       = quad,
  skip           = 6bp,
  figureposition = bottom,
  tableposition  = top,
}
\captionsetup[sub]{font=thu}
\renewcommand{\thesubfigure}{(\alph{subfigure})}
\renewcommand{\thesubtable}{(\alph{subtable})}
\newcommand\thu@set@table@font{
  \ifthu@language@chinese
    \def\thu@table@font{%
      \fontsize{11bp}{14.3bp}\selectfont
      \renewcommand\arraystretch{1.42}%
    }%
  \else
    \def\thu@table@font{%
      \fontsize{11bp}{12.65bp}\selectfont
      \renewcommand\arraystretch{1.47}%
    }%
  \fi
}
\thu@set@table@font
\thu@option@hook{language}{\thu@set@table@font}
\patchcmd\@floatboxreset{%
  \normalsize
}{%
  \thu@table@font
}{}{\thu@patch@error{\@floatboxreset}}
\AtEndOfPackageFile*{longtable}{
  \AtBeginEnvironment{longtable}{%
    \thu@table@font
  }
}
\heavyrulewidth=1.5bp
\lightrulewidth=1bp
\AtEndOfPackageFile*{threeparttable}{
  \g@addto@macro\TPT@defaults{\wuhao}
}
\newcommand{\thu@abstract@name}{摘\quad 要}
\newcommand{\thu@abstract@name@en}{Abstract}
\ctexset{%
  chapter = {
    nameformat   = {},
    numberformat = {},
    titleformat  = {},
    fixskip      = true,
    afterindent  = true,
    lofskip      = 0pt,
    lotskip      = 0pt,
  },
  section = {
    afterindent  = true,
  },
  subsection = {
    afterindent  = true,
  },
  subsubsection = {
    afterindent  = true,
  },
  paragraph/afterindent = true,
  subparagraph/afterindent = true,
}
\newcommand\thu@set@section@format{%
  \ifthu@degree@bachelor
    \ctexset{%
      chapter = {
        format     = \centering\sffamily\fontsize{16bp}{20.8bp}\selectfont,
        titleformat = \thu@stretch{3em},
        aftername  = \quad,
        beforeskip = 27bp,
        afterskip  = 27bp,
      },
      section = {
        format     = \sffamily\fontsize{14bp}{20bp}\selectfont,
        aftername  = \quad,
        beforeskip = 24bp,
        afterskip  = 6bp,
      },
      subsection = {
        format     = \sffamily\fontsize{13bp}{20bp}\selectfont,
        aftername  = \quad,
        beforeskip = 12bp,
        afterskip  = 6bp,
      },
      subsubsection = {
        format     = \sffamily\fontsize{12bp}{20bp}\selectfont,
        aftername  = \quad,
        beforeskip = 12bp,
        afterskip  = 6bp,
      },
    }%
    \ifthu@main@language@chinese
      \ctexset{
        chapter = {
          name   = {第,章},
          number = \thechapter,
        },
      }%
    \else
      \ctexset{
        chapter = {
          name   = \chaptername\space,
          number = \thu@english@number{chapter},
        },
      }%
    \fi
  \else
    \ctexset{%
      chapter = {
        titleformat = {},
        beforeskip = 27bp,
        afterskip  = 27bp,
        number     = \thechapter,
      },
      section = {
        beforeskip = 24bp,
        afterskip  = 6bp,
      },
      subsection = {
        beforeskip = 12bp,
        afterskip  = 6bp,
      },
      subsubsection = {
        beforeskip = 12bp,
        afterskip  = 6bp,
      },
    }%
    \ifthu@main@language@chinese
      \ctexset{%
        chapter = {
          format      = \centering\sffamily\sanhao,
          nameformat  = {},
          titleformat = {},
          name        = {第,章},
          aftername   = \quad,
        },
        section = {
          format     = \sffamily\fontsize{14bp}{20bp}\selectfont,
          aftername  = \quad,
        },
        subsection = {
          format     = \sffamily\fontsize{13bp}{20bp}\selectfont,
          aftername  = \quad,
        },
        subsubsection = {
          format     = \sffamily\fontsize{12bp}{20bp}\selectfont,
          aftername  = \quad,
        },
      }%
    \else
      \ctexset{%
        chapter = {
          format      = \centering\sffamily\bfseries\fontsize{16bp}{20bp}\selectfont,
          nameformat  = \MakeUppercase,
          titleformat = \MakeUppercase,
          name        = \chaptername\space,
          aftername   = \space,
        },
        section = {
          format     = \sffamily\bfseries\fontsize{14bp}{20bp}\selectfont,
          aftername  = \space,
        },
        subsection = {
          format     = \sffamily\bfseries\fontsize{13bp}{20bp}\selectfont,
          aftername  = \space,
        },
        subsubsection = {
          format     = \sffamily\bfseries\fontsize{12bp}{20bp}\selectfont,
          aftername  = \space,
        },
      }%
    \fi
  \fi
}
\thu@set@section@format
\thu@option@hook{degree}{\thu@set@section@format}
\thu@option@hook{main-language}{\thu@set@section@format}
\newcommand\thu@english@number[1]{%
  \expandafter\ifcase\csname c@#1\endcsname
    Zero\or
    One\or
    Two\or
    Three\or
    Four\or
    Five\or
    Six\or
    Seven\or
    Eight\or
    Nine\or
    Ten\or
    Eleven\or
    Twelve\or
    Thirteen\or
    Fourteen\or
    Fifteen\or
    Sixteen\or
    Seventeen\or
    Eighteen\or
    Nineteen\or
    Twenty\or
    \thu@error{You are genius}%
  \fi
}
\newcommand\thu@pdfbookmark[2]{}
\newcommand\thu@phantomsection{}
\NewDocumentCommand\thu@chapter{s o m o}{%
  \IfBooleanF{#1}{%
    \thu@error{You have to use the star form: \string\thu@chapter*}%
  }%
  \if@openright\cleardoublepage\else\clearpage\fi%
  \IfValueTF{#2}{%
    \ifthenelse{\equal{#2}{}}{%
      \thu@pdfbookmark{0}{#3}%
    }{%
      \thu@phantomsection
      \addcontentsline{toc}{chapter}{#2}%
    }%
  }{%
    \thu@phantomsection
    \addcontentsline{toc}{chapter}{#3}%
  }%
  \chapter*{#3}%
  \IfValueTF{#4}{%
    \ifthenelse{\equal{#4}{}}{%
      \@mkboth{}{}%
    }{%
      \@mkboth{#4}{#4}%
    }%
  }{%
    \@mkboth{#3}{#3}%
  }%
}
\setcounter{secnumdepth}{3}
\setcounter{tocdepth}{2}
\renewcommand\tableofcontents{%
  \ifthu@degree@graduate
    \thu@chapter*{\contentsname}%
  \else
    \ifthu@degree@bachelor
      \ctexset{chapter/titleformat = \thu@stretch{2.5em}}%
      \thu@chapter*[]{\contentsname}%
      \ctexset{chapter/titleformat = \thu@stretch{3em}}%
    \else
      \thu@chapter*[]{\contentsname}%
    \fi
  \fi
  \@starttoc{toc}%
}
\thu@define@key{
  toc-chapter-style = {
    name = toc@chapter@style,
    choices = {
      arial,
      times,
    },
    default = arial,
  },
}
\thu@option@hook{toc-chapter-style}{\thu@deprecate{"toc-chapter-style" option}{}}
\newcommand\thu@contents@label@delimiter{%
  \ifthu@degree@bachelor
    \ifthu@main@language@chinese
      \space
    \else
      \quad
    \fi
  \else
    \quad
  \fi
}
\newcommand\thu@leaders{\nobreak\titlerule*[4bp]{.}\nobreak}
\newcommand\thu@set@toc@format{%
  \contentsmargin{\z@}%
  \ifthu@degree@bachelor
    \ifthu@main@language@chinese
      \titlecontents{chapter}
        [0pt]{\sffamily}
        {\contentspush{\thecontentslabel\space}\thu@stretch{3em}}{\thu@stretch{3em}}
        {\rmfamily\thu@leaders\thecontentspage}%
      \titlecontents{section}
        [1em]{}
        {\contentspush{\thecontentslabel\space}}{}
        {\thu@leaders\thecontentspage}%
      \titlecontents{subsection}
        [2em]{}
        {\contentspush{\thecontentslabel\space}}{}
        {\thu@leaders\thecontentspage}%
    \else
      \ifthu@main@language@english
        \titlecontents{chapter}
          [\z@]{\addvspace{6bp}\sffamily}
          {\contentspush{\thecontentslabel\quad}}{}
          {\rmfamily\thu@leaders\thecontentspage}%
        \titlecontents{section}
          [0.5cm]{}
          {\contentspush{\thecontentslabel\quad}}{}
          {\thu@leaders\thecontentspage}%
        \titlecontents{subsection}
          [1cm]{}
          {\contentspush{\thecontentslabel\quad}}{}
          {\thu@leaders\thecontentspage}%
      \fi
    \fi
  \else
    \ifthu@main@language@chinese
      \titlecontents{chapter}
        [\z@]{\sffamily}
        {\contentspush{\thecontentslabel\quad}}{}
        {\rmfamily\thu@leaders\thecontentspage}%
      \titlecontents{section}
        [1em]{}
        {\contentspush{\thecontentslabel\quad}}{}
        {\thu@leaders\thecontentspage}%
      \titlecontents{subsection}
        [2em]{}
        {\contentspush{\thecontentslabel\quad}}{}
        {\thu@leaders\thecontentspage}%
    \else
      \titlecontents{chapter}
        [\z@]{\heiti}
        {\contentspush{\MakeUppercase{\thecontentslabel}\space}\MakeUppercase}{\MakeUppercase}
        {\rmfamily\thu@leaders\thecontentspage}%
      \titlecontents{section}
        [1em]{}
        {\contentspush{\thecontentslabel\space}}{}
        {\thu@leaders\thecontentspage}%
      \titlecontents{subsection}
        [2em]{}
        {\contentspush{\thecontentslabel\space}}{}
        {\thu@leaders\thecontentspage}%
    \fi
  \fi
}
\thu@set@toc@format
\thu@option@hook{degree}{\thu@set@toc@format}
\thu@option@hook{main-language}{\thu@set@toc@format}
\thu@define@key{
  secret-level = {
    name = secret@level,
  },
  secret-year = {
    name = secret@year,
  },
  title = {
    default = {标题},
  },
  title* = {
    default = {Title},
    name    = title@en,
  },
  author = {
    default = {姓名},
  },
  author* = {
    default = {Name of author},
    name    = author@en,
  },
  student-id = {
    name = student@id,
  },
  supervisor = {
    default = {导师姓名},
  },
  supervisor* = {
    default = {Name of supervisor},
    name    = supervisor@en,
  },
  associate-supervisor = {
    name = associate@supervisor,
  },
  associate-supervisor* = {
    name = associate@supervisor@en,
  },
  co-supervisor = {
    name = co@supervisor,
  },
  co-supervisor* = {
    name = co@supervisor@en,
  },
  % Reserved for compatibility
  joint-supervisor = {
    name = co@supervisor,
  },
  joint-supervisor* = {
    name = co@supervisor@en,
  },
  degree-category = {
    default = {工学博士},
    name    = degree@category,
  },
  degree-category* = {
    default = {Doctor of Philosophy},
    name    = degree@category@en,
  },
}
\thu@define@key{
  department = {
    default = {计算机科学与技术系},
  },
  discipline = {
    % default = {计算机科学与技术},
  },
  discipline* = {
    % default = {Computer Science and Technology},
    name    = discipline@en,
  },
}
\thu@option@hook{discipline}{%
  \ifthu@degree@type@professional
    \thu@warning{`discipline' for professional degree is deprecated. Use `professional-field' instead.}%
    \let\thu@professional@field\thu@discipline
    \let\thu@discipline\@empty
  \fi
}
\thu@option@hook{discipline*}{%
  \ifthu@degree@type@professional
    \thu@warning{`discipline*' for professional degree is deprecated. Use `professional-field*' instead.}%
    \let\thu@professional@field@en\thu@discipline@en
    \let\thu@discipline@en\@empty
  \fi
}
\thu@define@key{
  professional-field = {
    name    = professional@field,
  },
  professional-field* = {
    name    = professional@field@en,
  },
  engineering-field = {
    name    = engineering@field,
  },
  engineering-field* = {
    name    = engineering@field@en,
  },
  date = {
    default = {\the\year-\two@digits{\month}-\two@digits{\day}},
  },
  clc,
  udc,
  id,
  discipline-level-1 = {
    default = {一级学科名称},
    name    = discipline@level@i,
  },
  discipline-level-2 = {
    default = {二级学科名称},
    name    = discipline@level@ii,
  },
  start-date = {
    name    = start@date,
    default = {\the\year-\two@digits{\month}-\two@digits{\day}},
  },
  end-date = {
    name    = end@date,
    default = {\the\year-\two@digits{\month}-\two@digits{\day}},
  },
  include-spine = {
    name = include@spine,
    choices = {
      false,
      true,
    },
    default = false,
  },
}
\newcommand\thu@format@date[2]{%
  \edef\thu@@date{#2}%
  \def\thu@@process@date##1-##2-##3\@nil{%
    #1{##1}{##2}{##3}%
  }%
  \expandafter\thu@@process@date\thu@@date\@nil
}
\newcommand\thu@date@zh@digit[3]{#1 年 \number#2 月 \number#3 日}
\newcommand\thu@date@zh@digit@short[3]{#1 年 \number#2 月}
\newcommand\thu@date@zh@short[3]{\zhdigits{#1}年\zhnumber{#2}月}
\newcommand\thu@date@month[1]{%
  \ifcase\number#1\or
    January\or February\or March\or April\or May\or June\or
    July\or August\or September\or October\or November\or December%
  \fi
}
\newcommand\thu@date@en@short[3]{\thu@date@month{#2}, #1}
\newcommand\thu@underline[2][6em]{\hskip1pt\underline{\hb@xt@ #1{\hss#2\hss}}\hskip3pt}
\newcommand\thu@uline[2][6em]{\uline{\hb@xt@ #1{\hss#2\hss}}}
\newcommand\thu@fixed@box[2]{%
  \begingroup
    \ifLuaTeX
      \ltjsetparameter{kanjiskip = {0pt plus 2filll minus 1filll}}%
    \else
      \renewcommand\CJKglue{\hspace{0pt plus 2filll minus 1filll}}%
    \fi
    \makebox[#1][l]{#2}%
  \endgroup
}
\newbox\thu@stretch@box
\newcommand\thu@stretch[2]{%
  \sbox\thu@stretch@box{#2}%
  \ifdim \wd\thu@stretch@box < #1\relax
    \begingroup
      \ifLuaTeX
        \ltjsetparameter{kanjiskip = {0pt plus 2filll}}%
      \else
        \renewcommand\CJKglue{\hspace{0pt plus 2filll}}%
      \fi
      \makebox[#1][l]{#2}%
    \endgroup
  \else
    \box\thu@stretch@box
  \fi
}
\newbox\thu@pad@box
\newcommand\thu@pad[2]{%
  \sbox\thu@pad@box{#2}%
  \ifdim \wd\thu@pad@box < #1\relax
    \makebox[#1][l]{\box\thu@pad@box}%
  \else
    \box\thu@pad@box
  \fi
}
\newcounter{thu@csl@count}
\newcommand\thu@name@title@process[1]{%
  \ifcase\c@thu@csl@count  % == 0
    \gdef\thu@@name{#1}%
  \or  % == 1
    \gdef\thu@@title{#1}%
  \fi
  \stepcounter{thu@csl@count}%
}
\newcommand\thu@name@title@format[2]{%
  \thu@pad{3cm}{\thu@stretch{4em}{#1}}%
  \thu@stretch{3em}{#2}%
}
\newcommand\thu@name@title[1]{%
  \setcounter{thu@csl@count}{0}%
  \gdef\thu@@name{}%
  \gdef\thu@@title{}%
  \expandafter\comma@parse\expandafter{#1}{\thu@name@title@process}%
  \thu@name@title@format{\thu@@name}{\thu@@title}%
}
\renewcommand\maketitle{%
  \cleardoublepage
  \pagenumbering{Alph}%
  \thu@pdfbookmark{-1}{\thu@title}%
  \thu@titlepage
  \ifthu@include@spine@true
    \spine
  \fi
  \ifthu@degree@graduate
    \ifthu@thesis@type@thesis
      \cleardoublepage
      \thu@titlepage@en
    \fi
  \fi
  \clearpage
}
\newcommand\thu@titlepage{%
  \thusetup{language = chinese}%
  \ifthu@degree@graduate
    % 研究生
    \thu@titlepage@thesis
  \else
    \ifthu@degree@bachelor
      % 本科生
      \thu@titlepage@bachelor
    \else
      \ifthu@degree@postdoc
        % 博后
        \thu@cover@postdoc
        \cleardoublepage
        \thu@titlepage@postdoc
      \fi
    \fi
  \fi
  \thu@reset@main@language
}
\newcommand\thu@titlepage@thesis{%
  \newgeometry{
    top     = 2cm,
    bottom  = 6cm,
    hmargin = 3.5cm,
  }%
  \thispagestyle{empty}%
  \null\vskip 8.1pt%
  \begingroup
    \centering
    \parbox[t][2cm][t]{\textwidth}{%
      \hskip -21.5pt%
      \thu@titlepage@secret
    }\par
    \vskip 40.5pt%
    \begingroup
      \sffamily\fontsize{26bp}{46.8bp}\selectfont
      \thu@title\par
    \endgroup
    \ifthu@main@language@english
      \vskip 5.4pt%
      \begingroup
        \sffamily\bfseries\fontsize{20bp}{31.2bp}\selectfont
        \thu@title@en\par
      \endgroup
      \vskip -9.2pt%
    \fi
    \vskip 24.1pt%
    \thu@title@page@degree@category\par
    \vfill
    \ifthu@degree@type@academic
      \parbox[t][7.25cm][t]{\textwidth}{%
        \fangsong\fontsize{16bp}{31.2bp}\selectfont
        \thu@titlepage@info
      }\par
    \else
      \parbox[t][5.25cm][b]{\textwidth}{%
        \fangsong\fontsize{16bp}{31.2bp}\selectfont
        \thu@titlepage@info
      }\par
      \vskip 62pt%
    \fi
    \parbox[t][1.03cm][t]{\textwidth}{\centering\thu@titlepage@date}\par
  \endgroup
  \clearpage
  \restoregeometry
}
\newcommand\thu@set@student@id{%
  \ifthu@thesis@type@proposal\else
    \ifx\thu@student@id\@empty\else
      \thu@warning{`student-id' in "\protect\thusetup" would be ignored when `thesis-type' is not proposal.}%
    \fi
  \fi
}
\thu@set@student@id
\thu@option@hook{thesis-type}{\thu@set@student@id}
\thu@option@hook{student-id}{\thu@set@student@id}
\newcommand\thu@titlepage@secret{%
  \sffamily\sanhao
  \ifx\thu@secret@level\@empty
    \phantom{秘密}%
  \else
    \thu@secret@level\symbol{"2605}\makebox[3em][c]{\thu@secret@year}年%
  \fi\par
}
\newcommand\thu@title@page@degree@category{%
  \begingroup
    \fontsize{16bp}{22bp}\selectfont
    \ifLuaTeX
      \fontspec{\CJK@family}%
      \ltjsetparameter{kanjiskip = {1bp}}%
    \else
      \CJKfamily+{}%
      \renewcommand\CJKglue{\hspace{1bp}}%
    \fi
    \ifthu@thesis@type@thesis
      (申请清华大学\thu@degree@category
      \ifthu@degree@type@professional
        专业%
      \fi
      学位论文)%
    \else
      \ifthu@thesis@type@proposal
        (清华大学%
        \ifthu@degree@doctor
          博士%
        \else
          \ifthu@degree@master
            硕士%
          \fi
        \fi
        学位论文选题报告)%
      \fi
    \fi
    \par
  \endgroup
}
\newcommand\thu@titlepage@info{%
  \thu@titlepage@info@tabular{2.3cm}{2.85cm}{2.75cm}{0.77cm}{%
    \thu@info@item{培养单位}{}{\thu@department}%
    \ifthu@degree@type@academic
      \thu@info@item{学科}{}{\thu@discipline}%
      \thu@info@item{研究生}{\thu@name@title}{\thu@author}%
    \else
      \thu@info@item{专业领域}{}{\thu@professional@field}%
      \thu@info@item{工程领域}{}{\thu@engineering@field}%
      \thu@info@item{申请人}{\thu@name@title}{\thu@author}%
    \fi
    \ifthu@thesis@type@proposal
      \ifx\thu@student@id\@empty
        \thu@warning{Missing option `student-id' in "\protect\thusetup", ID will not appear on cover.}%
      \else
        \thu@info@item{学号}{}{\thu@student@id}%
      \fi
    \fi
    \thu@info@item{指导教师}{\thu@name@title}{\thu@supervisor}%
    \thu@info@item{副指导教师}{\thu@name@title}{\thu@associate@supervisor}%
    \thu@info@item{联合指导教师}{\thu@name@title}{\thu@co@supervisor}%
  }\par
}
\newcommand\thu@titlepage@info@tabular[5]{%
  \def\thu@info@item##1##2##3{%
    \ifx##3\@empty\else
      \thu@pad{#2}{\thu@fixed@box{#3}{##1}}%
      \thu@pad{#4}{：}%
      ##2{##3}\\
    \fi
  }%
  \hspace{#1}%
  \begin{tabular}{l}%
    \renewcommand\arraystretch{1}%
    #5%
  \end{tabular}%
}
\newcommand\thu@titlepage@date{%
  \begingroup
    \sanhao
    \ifLuaTeX
      \ltjsetparameter{kanjiskip = {1bp}}%
    \else
      \renewcommand\CJKglue{\hspace{1bp}}%
    \fi
    \thu@format@date{\thu@date@zh@short}{\thu@date}\par
  \endgroup
}
\newcommand{\thu@titlepage@en}{%
  \newgeometry{
    top     = 5.5cm,
    bottom  = 5cm,
    hmargin = 3.4cm,
  }%
  \thispagestyle{empty}%
  \thusetup{language = english}%
  \ifthu@degree@type@academic
    \thu@titlepage@en@graduate@academic
  \else
    \thu@titlepage@en@graduate@professional
  \fi
  \thu@reset@main@language
  \clearpage
  \restoregeometry
}
\newcommand\thu@titlepage@en@graduate@academic{%
  \begingroup
    \centering
    \null\vskip -0.31cm%
    \parbox[t][143bp][t]{\textwidth}{%
      \centering\thu@titlepage@en@title
    }\par
    \sanhao[1.725]%
    \thu@titlepage@en@degree
    \vskip 3bp%
    in\par
    \vskip 3.5bp%
    {\bfseries\sffamily\thu@discipline@en\par}%
    \vfill
    {\sffamily by\par}%
    \vskip 0.24cm%
    {\sffamily\bfseries\thu@author@en\par}%
    \vskip 0.18cm%
    \parbox[t][3.0cm][t]{\textwidth}{%
      \centering
      \xiaosan[2.1]%
      \thu@titlepage@en@supervisor
    }\par
    \thu@titlepage@en@date
    \vskip 0.7cm%
  \endgroup
}
\newcommand\thu@titlepage@en@graduate@professional{%
  \begingroup
    \centering
    \null\vskip -0.31cm%
    \parbox[t][143bp][t]{\textwidth}{%
      \centering\thu@titlepage@en@title
    }\par
    \sanhao[1.725]%
    \thu@titlepage@en@degree
    \vfill
    {\sffamily by\par}%
    \vskip 0.24cm%
    {\sffamily\bfseries\thu@author@en\par}%
    \ifx\thu@professional@field@en\empty
      \vskip 1.95cm%
    \else
      \vskip -0.1cm%
      {\sffamily\bfseries(\thu@professional@field@en)\par}%
      \vskip 1.1cm%
    \fi
    \parbox[t][3.37cm][t]{\textwidth}{%
      \centering
      \xiaosan[1.82]%
      \thu@titlepage@en@supervisor
    }\par
    \thu@titlepage@en@date
    \vskip 0.3cm%
  \endgroup
}
\newcommand\thu@titlepage@en@title{%
  \begingroup
    % 对齐到网格，每行 15.6bp
    \sffamily\bfseries\fontsize{20bp}{31.2bp}\selectfont
    \thu@title@en\par
  \endgroup
}
\newcommand\thu@thesis@name@en{%
  \ifthu@degree@master
    Thesis%
  \else
    Dissertation%
  \fi
}
\newcommand\thu@titlepage@en@degree{%
  \thu@thesis@name@en{} submitted to\par
  {\bfseries Tsinghua University\par}%
  in partial fulfillment of the requirement\par
  for the
  \ifthu@degree@type@professional
    professional
  \fi
  degree of\par
  {\sffamily\bfseries\thu@degree@category@en\par}%
}
\newcommand\thu@titlepage@en@supervisor{%
  \begin{tabular}{r@{\makebox[20.5bp][l]{\hspace{2bp}:}}l}%
    \renewcommand\arraystretch{1}%
    \thu@thesis@name@en{} Supervisor & \thu@supervisor@en \\
    \ifx\thu@associate@supervisor@en\@empty\else
      Associate Supervisor           & \thu@associate@supervisor@en \\
    \fi
    \ifx\thu@co@supervisor@en\@empty\else
      Co-supervisor                  & \thu@co@supervisor@en \\
    \fi
  \end{tabular}%
}
\newcommand\thu@titlepage@en@date{%
  \begingroup
    \sffamily\bfseries\sanhao
    \thu@format@date{\thu@date@en@short}{\thu@date}\par
  \endgroup
}
\newlength\thu@info@label@width
\newlength\thu@info@label@text@width
\newcommand\thu@titlepage@bachelor{%
  \newgeometry{
    top    = 3.8cm,
    bottom = 3.2cm,
    left   = 3.2cm,  % 装订线靠左 0.2 cm
    right  = 3cm,
  }%
  \thispagestyle{empty}%
  \begingroup
    \centering
    \parbox[t][0cm][t]{\textwidth}{%
      \hfill
      \xiaosi
      \ifx\thu@secret@level\@empty\else
        \thu@secret@level\space\thu@secret@year 年\par
      \fi
    }\par
  \endgroup
  \vspace{19bp}%
  \begingroup
    \centering
    \hspace*{-5bp}%
    \includegraphics[width=50.4bp]{thu-fig-logo.pdf}%
    \hspace{10bp}%
    \raisebox{7bp}{\includegraphics[width=117bp]{thu-text-logo.pdf}}%
    \par
    \vspace{17bp}%
    \begingroup
      \sffamily\bfseries\xiaochu\ziju{0.3}%
      综合论文训练%
      \ifthu@thesis@type@proposal
        \\开题报告
      \fi
      \par
    \endgroup
    \vspace{48bp}%
    \parbox[t][136bp]{\linewidth}{%
      \centering
      \heiti\fontsize{26bp}{32.5bp}\selectfont
      \thu@title\par
      \ifthu@main@language@english
        \thusetup{language=english}%
        \thu@title@en\par
        \thusetup{language=chinese}%
      \fi
    }\par
  \endgroup
  \begingroup
    \fangsong
    \fontsize{16bp}{30.96bp}\selectfont
    \noindent
    \def\thu@name@title@format##1##2{%
      \thu@stretch{4em}{##1}%
      \hspace{1.5em}%
      \thu@stretch{2.5em}{##2}%
    }%
    \ifx\thu@co@supervisor\@empty
      \setlength\thu@info@label@width{2.5cm}%
      \setlength\thu@info@label@text@width{4em}%
    \else
      \setlength\thu@info@label@width{86bp}%
      \setlength\thu@info@label@text@width{5em}%
    \fi
    \thu@titlepage@info@tabular{81bp}{\thu@info@label@width}{\thu@info@label@text@width}{0.82cm}{%
      \thu@info@item{系别}{}{\thu@department}%
      \thu@info@item{专业}{}{\thu@discipline}%
      \thu@info@item{姓名}{\thu@name@title}{\thu@author}%
      \thu@info@item{指导教师}{\thu@name@title}{\thu@supervisor}%
      \thu@info@item{副指导教师}{\thu@name@title}{\thu@associate@supervisor}%
      \thu@info@item{联合指导教师}{\thu@name@title}{\thu@co@supervisor}%
    }\par
  \endgroup
  \vfill
  \begingroup
    \centering
    \fontsize{16bp}{24bp}\selectfont
    \ziju{0.03}%
    \thu@format@date{\thu@date@zh@short}{\thu@date}\par
  \endgroup
  \vspace*{60bp}%
  \clearpage
  \restoregeometry
}
\newcommand\thu@cover@postdoc{%
  \thispagestyle{empty}%
  \begin{center}%
    \renewcommand\ULthickness{0.7pt}%
    \vspace*{0.35cm}%
    {\sihao[2.6]%
      \thu@stretch{3.1em}{分类号}\thu@underline[3.7cm]{\thu@clc}\hfill
      密级\thu@underline[3.7cm]{\thu@secret@level}\par
      \thu@stretch{3.1em}{U D C}\thu@underline[3.7cm]{\thu@udc}\hfill
      编号\thu@underline[3.7cm]{\thu@id}\par
    }%
    \vskip 3.15cm%
    {\sffamily\bfseries\xiaoer[2.6]%
      {\ziju{1.5}清华大学\par}%
      {\ziju{0.5}博士后研究工作报告\par}%
    }%
    \vskip 0.2cm%
    \parbox[t][4.0cm][c]{\textwidth}{%
      \centering\sihao[3.46]%
      \renewcommand\ULdepth{1em}%
      \expandafter\uline\expandafter{\thu@title}\par
    }\par
    \vskip 0.4cm%
    {\xiaosi\thu@author\par}%
    \vskip 1.4cm%
    {\xiaosi[1.58]%
      \renewcommand\ULdepth{0.9em}%
      工作完成日期\quad
      \thu@uline[5.9cm]{%
        \thu@format@date{\thu@date@zh@digit@short}{\thu@start@date}—%
        \thu@format@date{\thu@date@zh@digit@short}{\thu@end@date}%
      }\par
      \vskip 0.55cm%
      报告提交日期\quad
      \thu@uline[5.9cm]{\thu@format@date{\thu@date@zh@digit@short}{\thu@date}}\par
    }%
    \vskip 0.45cm%
    {\xiaosi[2]{\ziju{1}清华大学}\quad （北京）\par}%
    \vskip 0.25cm%
    {\xiaosi[2]\thu@format@date{\thu@date@zh@digit@short}{\thu@date}\par}%
  \end{center}%
}
\newcommand\thu@titlepage@postdoc{%
  \thispagestyle{empty}%
  \begin{center}%
    \vspace*{1.5cm}%
    \parbox[t][3cm][c]{\textwidth}{%
      \centering\sanhao[1.95]\thu@title\par
    }\par
    \vskip 0.15cm%
    \parbox[t][3cm][c]{\textwidth}{%
      \centering\sihao[1.36]\thu@title@en\par
    }\par
    \vskip 0.4cm%
    {\xiaosi[2.6]%
      \begin{tabular}{l@{\quad}l}%
        \renewcommand\arraystretch{1}%
        \thu@stretch{11em}{博士后姓名}                  & \thu@author           \\
        \thu@stretch{11em}{流动站（一级学科）名称}      & \thu@discipline@level@i  \\
        \thu@stretch{11em}{专\quad{}业（二级学科）名称} & \thu@discipline@level@ii \\
      \end{tabular}\par
    }%
    \vskip 2.7cm%
    {\xiaosi[2.6]%
      研究工作起始时间\quad\thu@format@date{\thu@date@zh@digit}{\thu@start@date}\par
      \vskip 0.1cm%
      研究工作期满时间\quad\thu@format@date{\thu@date@zh@digit}{\thu@end@date}\par
    }%
    \vskip 2.1cm%
    {\xiaosi[2.6]清华大学人事处（北京）\par}%
    \vskip 0.6cm%
    {\wuhao\thu@format@date{\thu@date@zh@digit@short}{\thu@date}\par}%
  \end{center}%
}
\def\thu@committee@name{学位论文指导小组、公开评阅人和答辩委员会名单}
\NewEnviron{committee}[1][]{%
  \ifthu@degree@graduate
    \cleardoublepage
    \let\thu@committee@file\@empty
    \kv@define@key{thu@committee}{name}{\let\thu@committee@name\kv@value}%
    \kv@define@key{thu@committee}{file}{\let\thu@committee@file\kv@value}%
    \kv@set@family@handler{thu@committee}{%
      \ifx\kv@value\relax
        \let\thu@committee@file\kv@key
      \else
        \kv@handled@false
      \fi
    }%
    \kvsetkeys{thu@committee}{#1}%
    \ifx\thu@committee@file\@empty
      \begingroup
        \ctexset{
          chapter = {
            format    = \centering\sffamily\fontsize{16bp}{20bp}\selectfont,
            afterskip = 49bp,
          },
          section = {
            beforeskip  =  26bp,
            afterskip   =  9.5bp,
            format      += \centering,
            numbering   =  false,
            afterindent =  false,
          },
        }%
        \thu@chapter*[]{\thu@committee@name}%
        \thispagestyle{empty}%
        \thusetup{language=chinese}%
        \BODY\clearpage
        \thu@reset@main@language
      \endgroup
    \else
      \thu@pdfbookmark{0}{\thu@committee@name}%
      \includepdf{\thu@committee@file}%
    \fi
  \fi
}
\newcommand\copyrightpage[1][]{%
  \ifthu@degree@postdoc\relax\else
    \cleardoublepage
    \def\thu@@tmp{#1}%
    \ifx\thu@@tmp\@empty
      \thusetup{language=chinese}%
      \ifthu@degree@bachelor
        \thu@copyright@page@bachelor
      \else
        \thu@copyright@page@graduate
      \fi
      \clearpage
      \thu@reset@main@language
    \else
      \thispagestyle{empty}%
      \thu@pdfbookmark{0}{关于学位论文使用授权的说明}%
      \thu@phantomsection
      \kv@define@key{thu@copyright}{file}{\includepdf{\kv@value}}%
      \kv@set@family@handler{thu@copyright}{%
        \ifx\kv@value\relax
          \includepdf{\kv@key}%
        \else
          \kv@handled@false
        \fi
      }%
      \kvsetkeys{thu@copyright}{#1}%
    \fi
  \fi
  \thu@replace@with@error{copyrightpage}
}
\newcommand{\thu@authorization@frontdate}{%
  日\ifthu@degree@bachelor\hspace{1em}\else\hspace{2em}\fi 期：}
\newcommand\thu@copyright@page@graduate{%
  \begingroup
    \ctexset{
      chapter = {
        format     = {\centering\sffamily\erhao},
        beforeskip = 40bp,
        afterskip  = 36bp,
      },
    }%
    \thu@chapter*[]{关于学位论文使用授权的说明}%
  \endgroup
  \thispagestyle{empty}%
  \vskip 13bp%
  \begingroup
    \fontsize{14bp}{26bp}\selectfont
    本人完全了解清华大学有关保留、使用学位论文的规定，即：\par
    清华大学拥有在著作权法规定范围内学位论文的使用权，其中包括：%
    （1）\nobreak 已获学位的研究生必须按学校规定提交学位论文，%
    学校可以采用影印、缩印或其他复制手段保存研究生上交的学位论文；\allowbreak
    （2）\nobreak 为教学和科研目的，学校可以将公开的学位论文作为资料在图书馆、资料室等场所供校内师生阅读，%
    或在校园网上供校内师生浏览部分内容；\allowbreak
    \hbox{}（3）\nobreak 根据《中华人民共和国学位法》及上级教育主管部门要求，
    报送相应的学位论文。\par
    本人保证遵守上述规定。\par
  \endgroup
  \vskip 33bp%
  \begingroup
    \fontsize{12bp}{23.4bp}\selectfont
    \parindent\z@
    \leftskip 43bp%
    作者签名：\hspace{4bp}\thu@underline[7em]{}\hspace{47bp}%
    导师签名：\hspace{4bp}\thu@underline[7em]{}\par
    \vskip 6bp%
    日\hspace{2em}期：\hspace{4bp}\thu@underline[7em]{}\hspace{47bp}%
    日\hspace{2em}期：\hspace{4bp}\thu@underline[7em]{}\par
  \endgroup
}
\newcommand\thu@copyright@page@bachelor{%
  \begingroup
    \ctexset{
      chapter = {
        format     = {\centering\sffamily\erhao},
        beforeskip = 40bp,
        afterskip  = 37bp,
      },
    }%
    \thu@chapter*[]{关于论文使用授权的说明}%
  \endgroup
  \thispagestyle{empty}%
  \vspace*{13bp}%
  \begingroup
    \fontsize{14bp}{26bp}\selectfont
    本人完全了解清华大学有关保留、使用综合论文训练论文的规定，即：%
    学校有权保留论文的复印件，允许论文被查阅和借阅；%
    学校可以公布论文的全部或部分内容，可以采用影印、缩印或其他复制手段保存论文。\par
  \endgroup
  \vspace{71bp}%
  \begingroup
    \setlength{\parindent}{0pt}%
    \fontsize{12bp}{18bp}\selectfont
    \hspace*{42bp}作者签名：\hspace{118bp}导师签名：\par
    \vspace{11bp}%
    \hspace*{42bp}日\hspace{2em}期：\hspace{118bp}日\hspace{2em}期：\par
  \endgroup
}
\thu@define@key{
  keywords,
  keywords* = {
    name = keywords@en,
  },
}
\newcommand\thu@clist@use[2]{%
  \def\thu@@tmp{}%
  \def\thu@clist@processor##1{%
    \ifx\thu@@tmp\@empty
      \def\thu@@tmp{#2}%
    \else
      #2%
    \fi
    ##1%
  }%
  \expandafter\comma@parse\expandafter{#1}{\thu@clist@processor}%
}
\newenvironment{abstract}{%
  \thusetup{language = chinese}%
  \ifthu@degree@graduate
    \begingroup
      \ifthu@main@language@english
        \ctexset{%
          chapter/format = \centering\sffamily\fontsize{16bp}{20bp}\selectfont,
        }%
      \fi
      \thu@chapter*{\thu@abstract@name}%
    \endgroup
  \else
    \thu@chapter*[]{\thu@abstract@name}%
  \fi
}{%
  \par
  \null\par
  \ifthu@degree@postdoc
    \textbf{关键词：}%
  \else
    \noindent
    \textsf{关键词：}%
  \fi
  \thu@clist@use{\thu@keywords}{；}\par
  \gdef\thu@keywords{}%
  \thu@reset@main@language % switch back to main language
}
\newenvironment{abstract*}{%
  \thusetup{language = english}%
  \ifthu@degree@bachelor
    \begingroup
      \ctexset{chapter/afterskip = 30bp}%
      \thu@chapter*[]{\thu@abstract@name@en}%
    \endgroup
  \else
    \ifthu@degree@graduate
      \thu@chapter*{\thu@abstract@name@en}%
    \else
      \thu@chapter*[]{\thu@abstract@name@en}%
    \fi
  \fi
}{%
  \par
  \null\par
  \ifthu@degree@postdoc\else
    \noindent
  \fi
  \textbf{Keywords:} \thu@clist@use{\thu@keywords@en}{; }\par
  \thu@reset@main@language % switch back to main language
}
\newenvironment{denotation}[1][2.5cm]{%
  \ifthu@degree@bachelor
    \ifthu@main@language@chinese
      \thu@chapter*[]{\thu@denotation@name}%
    \else
      \thu@chapter*{\thu@denotation@name}%
    \fi
  \else
    \ifthu@degree@graduate
      \thu@chapter*{\thu@denotation@name}%
    \else
      \thu@chapter*[]{\thu@denotation@name}%
    \fi
  \fi
  \begin{thu@denotation}[labelwidth=#1]%
}{%
  \end{thu@denotation}%
}
\newlist{thu@denotation}{description}{1}
\setlist[thu@denotation]{%
  nosep,
  font=\normalfont,
  align=left,
  leftmargin=!, % sum of the following 3 lengths
  labelindent=0pt,
  labelwidth=2.5cm,
  labelsep*=0.5cm,
  itemindent=0pt,
}
\newcommand{\thu@statement@text@bachelor}{%
  本人郑重声明：所呈交的综合论文训练论文，是本人在导师指导下，独立进行研究工作所取得的成果。%
  尽我所知，除文中已经注明引用的内容外，本论文的研究成果不包含任何他人享有著作权的内容。%
  对本论文所涉及的研究工作做出贡献的其他个人和集体，均已在文中以明确方式标明。%
}
\newcommand{\thu@statement@text@graduate}{%
  本人郑重声明：所呈交的学位论文，是本人在导师指导下，独立进行研究工作所取得的成果%
  \ifx\thu@secret@level\@empty
    ，不包含涉及国家秘密的内容%
  \fi%
  。尽我所知，除文中已经注明引用的内容外，本学位论文的研究成果不包含任何他人享有著作权的内容。%
  对本论文所涉及的研究工作做出贡献的其他个人和集体，均已在文中以明确方式标明。%
}
\newcommand{\thu@signature}{签\hspace{1em}名：}
\newcommand{\thu@backdate}{日\hspace{1em}期：}
\newenvironment{acknowledgements}{%
  \@mainmatterfalse
  \thu@end@appendix@ref@section
  \thu@chapter*{\thu@acknowledgements@name}%
}{%
}
\thu@define@key{
  statement-page-style = {
    name = statement@page@style,
    choices = {
      plain,
      empty,
    },
    default = plain,
  }
}
\newcommand\statement[1][]{%
  \@mainmatterfalse
  \thu@end@appendix@ref@section
  \let\thu@statement@file\@empty
  \kv@define@key{thu@statement}{page-style}{\thusetup{statement-page-style=##1}}%
  \kv@define@key{thu@statement}{file}{\let\thu@statement@file\kv@value}%
  \kv@set@family@handler{thu@statement}{%
    \ifx\kv@value\relax
      \let\thu@statement@file\kv@key
    \else
      \kv@handled@false
    \fi
  }%
  \kvsetkeys{thu@statement}{#1}%
  \ifx\thu@statement@file\@empty
    \thusetup{language=chinese}%
    \begingroup
      \ifthu@degree@graduate
        \ifthu@main@language@english
          \ctexset{%
            chapter/format = \centering\sffamily\fontsize{16bp}{20bp}\selectfont,
          }%
        \fi
      \fi
      \thu@chapter*{\thu@statement@name}%
    \endgroup
    \thispagestyle{\thu@statement@page@style}%
    \ifthu@degree@graduate
      \vspace{13bp}%
      \fontsize{12bp}{21bp}\selectfont
      \begingroup
        \renewcommand\CJKglue{\hspace{.15bp plus .1bp}}%
        \thu@statement@text@graduate\par
      \endgroup
      \vspace{78.5bp}%
      \begingroup
        \noindent\hspace{153.5bp}\fontsize{13bp}{18bp}\selectfont
        \thu@signature\thu@underline[76bp]{}\hspace{-3bp}%
        \thu@backdate\thu@underline[65bp]{}\par
      \endgroup
    \else
      \ifthu@degree@bachelor
        \begingroup
          \renewcommand\CJKglue{\hspace{.1bp}}%
          \thu@statement@text@bachelor\par
        \endgroup
        \vspace{40bp}%
        \hfill 签\hspace{.5em}名：\thu@underline[2.75cm]{}\hspace{.5em}%
        日\hspace{.5em}期：\thu@underline[2.75cm]{}\par
      \fi
    \fi
    \thu@reset@main@language
  \else
    \includepdf[pagecommand={%
      \markboth{\thu@statement@name}{}%
      \thu@phantomsection
      \addcontentsline{toc}{chapter}{\thu@statement@name}%
      \thispagestyle{\thu@statement@page@style}%
    }]{\thu@statement@file}%
  \fi
  \thu@replace@with@error{statement}
}
\let\acknowledgement\acknowledgements
\let\endacknowledgement\endacknowledgements
\def\thu@listof#1{% #1: float type
  \setcounter{tocdepth}{2}%  restore tocdepth in case being modified
  \@ifstar{\thu@deprecate{starred form of \protect\listof... command}{}}{}%
  \ifthu@degree@bachelor
    \ifthu@main@language@chinese
      \thu@chapter*[]{\csname list#1name\endcsname}%
    \else
      \thu@chapter*{\csname list#1name\endcsname}%
    \fi
  \else
    \ifthu@degree@graduate
      \thu@chapter*{\csname list#1name\endcsname}%
    \else
      \thu@chapter*[]{\csname list#1name\endcsname}%
    \fi
  \fi
  \@starttoc{\csname ext@#1\endcsname}%
}
\renewcommand\listoffigures{%
  \thu@listof{figure}%
}
\titlecontents{figure}
  [\z@]{}
  {\contentspush{\figurename~\thecontentslabel\thu@contents@label@delimiter}}{}
  {\thu@leaders\thecontentspage}
\renewcommand\listoftables{%
  \thu@listof{table}%
}
\titlecontents{table}
  [\z@]{}
  {\contentspush{\tablename~\thecontentslabel\thu@contents@label@delimiter}}{}
  {\thu@leaders\thecontentspage}
\newcommand\listoffiguresandtables{%
  \ifthu@degree@bachelor
    \ifthu@main@language@chinese
      \thu@chapter*[]{\thu@list@figure@table@name}%
    \else
      \thu@chapter*{\thu@list@figure@table@name}%
    \fi
  \else
    \ifthu@degree@graduate
      \thu@chapter*{\thu@list@figure@table@name}%
    \else
      \thu@chapter*[]{\thu@list@figure@table@name}%
    \fi
  \fi
  \@starttoc{lof}%
  \par
  \null\par
  \@starttoc{lot}%
}
\def\ext@equation{loe}
\def\equcaption#1{%
  \thu@deprecate{"\protect\equcaption" command}{}%
  \addcontentsline{\ext@equation}{equation}%
                  {\protect\numberline{#1}}}
\newcommand\listofequations{%
  \thu@deprecate{"\protect\listofequations" command}{}%
  \thu@listof{equation}%
}
\titlecontents{equation}
  [0pt]{\addvspace{6bp}}
  {\contentspush{\thu@equation@name~\thecontentslabel\thu@contents@label@delimiter}}{}
  {\thu@leaders\thecontentspage}
\contentsuse{equation}{loe}
\thu@define@key{
  cite-style = {
    name = cite@style,
    choices = {
      super,
      inline,
      author-year,
    }
  }
}
\newcommand\thu@bib@heading[1]{\thu@chapter*{#1}}
\def\bibliographystyle#1{%
  \gdef\bu@bibstyle{#1}%
  \ifx\@begindocumenthook\@undefined\else
    \expandafter\AtBeginDocument
  \fi
    {\if@filesw
       \immediate\write\@auxout{\string\bibstyle{#1}}%
       \immediate\write\@auxout{\string\gdef\string\bu@bibstyle{#1}}%
     \fi}%
}
\def\bibliography#1{%
  \if@filesw
    \immediate\write\@auxout{\string\bibdata{\zap@space#1 \@empty}}%
    \immediate\write\@auxout{\string\gdef\string\bu@bibdata{#1}}%
  \fi
  \gdef\bu@bibdata{#1}%
  \@input@{\jobname.bbl}}
\PassOptionsToPackage{compress}{natbib}
\AtEndOfPackageFile*{natbib}{
  \DeclareRobustCommand\inlinecite{\@inlinecite}
  \def\@inlinecite#1{\begingroup\let\@cite\NAT@citenum\citep{#1}\endgroup}
  \let\onlinecite\inlinecite
  \newcommand\bibstyle@super{%
    \bibpunct{[}{]}{,}{s}{,}{\textsuperscript{,}}}
  \newcommand\bibstyle@inline{%
    \bibpunct{[}{]}{,}{n}{,}{,}}
  \@namedef{bibstyle@author-year}{%
    \bibpunct{(}{)}{;}{a}{,}{,}}
  \thu@option@hook{cite-style}{\@nameuse{bibstyle@\thu@cite@style}}
  \@namedef{bibstyle@thuthesis-numeric}{\citestyle{super}}
  \@namedef{bibstyle@thuthesis-author-year}{\citestyle{author-year}}
  \@namedef{bibstyle@cell}{\citestyle{author-year}}
  \@namedef{bibstyle@thuthesis-bachelor}{\citestyle{super}}
  \renewcommand\NAT@citesuper[3]{%
    \ifNAT@swa
      \if*#2*\else
        #2\NAT@spacechar
      \fi
      % \unskip\kern\p@\textsuperscript{\NAT@@open#1\NAT@@close}%
      %  \if*#3*\else\NAT@spacechar#3\fi\else #1\fi\endgroup}
      \unskip\kern\p@
      \textsuperscript{%
        \NAT@@open#1\NAT@@close
        \if*#3*\else#3\fi
      }%
      \kern\p@
    \else
      #1%
    \fi
    \endgroup
  }
  \renewcommand\NAT@citenum[3]{%
    \ifNAT@swa
      \NAT@@open
      \if*#2*\else
        #2\NAT@spacechar
      \fi
      % #1\if*#3*\else\NAT@cmt#3\fi\NAT@@close
      #1\NAT@@close
      \if*#3*\else
        \textsuperscript{#3}%
      \fi
    \else
      #1%
    \fi
    \endgroup
  }
  \def\NAT@citexnum[#1][#2]#3{%
    \NAT@reset@parser
    \NAT@sort@cites{#3}%
    \NAT@reset@citea
    \@cite{\def\NAT@num{-1}\let\NAT@last@yr\relax\let\NAT@nm\@empty
      \@for\@citeb:=\NAT@cite@list\do
      {\@safe@activestrue
      \edef\@citeb{\expandafter\@firstofone\@citeb\@empty}%
      \@safe@activesfalse
      \@ifundefined{b@\@citeb\@extra@b@citeb}{%
        {\reset@font\bfseries?}
          \NAT@citeundefined\PackageWarning{natbib}%
        {Citation `\@citeb' on page \thepage \space undefined}}%
      {\let\NAT@last@num\NAT@num\let\NAT@last@nm\NAT@nm
        \NAT@parse{\@citeb}%
        \ifNAT@longnames\@ifundefined{bv@\@citeb\@extra@b@citeb}{%
          \let\NAT@name=\NAT@all@names
          \global\@namedef{bv@\@citeb\@extra@b@citeb}{}}{}%
        \fi
        \ifNAT@full\let\NAT@nm\NAT@all@names\else
          \let\NAT@nm\NAT@name\fi
        \ifNAT@swa
        \@ifnum{\NAT@ctype>\@ne}{%
          \@citea
          \NAT@hyper@{\@ifnum{\NAT@ctype=\tw@}{\NAT@test{\NAT@ctype}}{\NAT@alias}}%
        }{%
          \@ifnum{\NAT@cmprs>\z@}{%
          \NAT@ifcat@num\NAT@num
            {\let\NAT@nm=\NAT@num}%
            {\def\NAT@nm{-2}}%
          \NAT@ifcat@num\NAT@last@num
            {\@tempcnta=\NAT@last@num\relax}%
            {\@tempcnta\m@ne}%
          \@ifnum{\NAT@nm=\@tempcnta}{%
            \@ifnum{\NAT@merge>\@ne}{}{\NAT@last@yr@mbox}%
          }{%
            \advance\@tempcnta by\@ne
            \@ifnum{\NAT@nm=\@tempcnta}{%
              % \ifx\NAT@last@yr\relax
              %   \def@NAT@last@yr{\@citea}%
              % \else
              %   \def@NAT@last@yr{--\NAT@penalty}%
              % \fi
              \ifthu@degree@bachelor
                \ifx\NAT@last@yr\relax
                  \def@NAT@last@yr{\@citea}%
                \else
                  \def@NAT@last@yr{-\NAT@penalty}%
                \fi
              \else
                \def@NAT@last@yr{-\NAT@penalty}%
              \fi
            }{%
              \NAT@last@yr@mbox
            }%
          }%
          }{%
          \@tempswatrue
          \@ifnum{\NAT@merge>\@ne}{\@ifnum{\NAT@last@num=\NAT@num\relax}{\@tempswafalse}{}}{}%
          \if@tempswa\NAT@citea@mbox\fi
          }%
        }%
        \NAT@def@citea
        \else
          \ifcase\NAT@ctype
            \ifx\NAT@last@nm\NAT@nm \NAT@yrsep\NAT@penalty\NAT@space\else
              \@citea \NAT@test{\@ne}\NAT@spacechar\NAT@mbox{\NAT@super@kern\NAT@@open}%
            \fi
            \if*#1*\else#1\NAT@spacechar\fi
            \NAT@mbox{\NAT@hyper@{{\citenumfont{\NAT@num}}}}%
            \NAT@def@citea@box
          \or
            \NAT@hyper@citea@space{\NAT@test{\NAT@ctype}}%
          \or
            \NAT@hyper@citea@space{\NAT@test{\NAT@ctype}}%
          \or
            \NAT@hyper@citea@space\NAT@alias
          \fi
        \fi
      }%
      }%
        \@ifnum{\NAT@cmprs>\z@}{\NAT@last@yr}{}%
        \ifNAT@swa\else
          % \@ifnum{\NAT@ctype=\z@}{%
          %   \if*#2*\else\NAT@cmt#2\fi
          % }{}%
          \NAT@mbox{\NAT@@close}%
          \@ifnum{\NAT@ctype=\z@}{%
            \if*#2*\else
              \textsuperscript{#2}%
            \fi
          }{}%
          \NAT@super@kern
        \fi
    }{#1}{#2}%
  }%
  \renewcommand\NAT@cite%
      [3]{\ifNAT@swa\NAT@@open\if*#2*\else#2\NAT@spacechar\fi
          % #1\if*#3*\else\NAT@cmt#3\fi\NAT@@close\else#1\fi\endgroup}
          #1\NAT@@close\if*#3*\else\textsuperscript{#3}\fi\else#1\fi\endgroup}
  \def\NAT@citex%
    [#1][#2]#3{%
    \NAT@reset@parser
    \NAT@sort@cites{#3}%
    \NAT@reset@citea
    \@cite{\let\NAT@nm\@empty\let\NAT@year\@empty
      \@for\@citeb:=\NAT@cite@list\do
      {\@safe@activestrue
      \edef\@citeb{\expandafter\@firstofone\@citeb\@empty}%
      \@safe@activesfalse
      \@ifundefined{b@\@citeb\@extra@b@citeb}{\@citea%
        {\reset@font\bfseries ?}\NAT@citeundefined
                  \PackageWarning{natbib}%
        {Citation `\@citeb' on page \thepage \space undefined}\def\NAT@date{}}%
      {\let\NAT@last@nm=\NAT@nm\let\NAT@last@yr=\NAT@year
        \NAT@parse{\@citeb}%
        \ifNAT@longnames\@ifundefined{bv@\@citeb\@extra@b@citeb}{%
          \let\NAT@name=\NAT@all@names
          \global\@namedef{bv@\@citeb\@extra@b@citeb}{}}{}%
        \fi
      \ifNAT@full\let\NAT@nm\NAT@all@names\else
        \let\NAT@nm\NAT@name\fi
      \ifNAT@swa\ifcase\NAT@ctype
        \if\relax\NAT@date\relax
          \@citea\NAT@hyper@{\NAT@nmfmt{\NAT@nm}\NAT@date}%
        \else
          \ifx\NAT@last@nm\NAT@nm\NAT@yrsep
              \ifx\NAT@last@yr\NAT@year
                \def\NAT@temp{{?}}%
                \ifx\NAT@temp\NAT@exlab\PackageWarningNoLine{natbib}%
                {Multiple citation on page \thepage: same authors and
                year\MessageBreak without distinguishing extra
                letter,\MessageBreak appears as question mark}\fi
                \NAT@hyper@{\NAT@exlab}%
              \else\unskip\NAT@spacechar
                \NAT@hyper@{\NAT@date}%
              \fi
          \else
            \@citea\NAT@hyper@{%
              \NAT@nmfmt{\NAT@nm}%
              \hyper@natlinkbreak{%
                \NAT@aysep\NAT@spacechar}{\@citeb\@extra@b@citeb
              }%
              \NAT@date
            }%
          \fi
        \fi
      \or\@citea\NAT@hyper@{\NAT@nmfmt{\NAT@nm}}%
      \or\@citea\NAT@hyper@{\NAT@date}%
      \or\@citea\NAT@hyper@{\NAT@alias}%
      \fi \NAT@def@citea
      \else
        \ifcase\NAT@ctype
          \if\relax\NAT@date\relax
            \@citea\NAT@hyper@{\NAT@nmfmt{\NAT@nm}}%
          \else
          \ifx\NAT@last@nm\NAT@nm\NAT@yrsep
              \ifx\NAT@last@yr\NAT@year
                \def\NAT@temp{{?}}%
                \ifx\NAT@temp\NAT@exlab\PackageWarningNoLine{natbib}%
                {Multiple citation on page \thepage: same authors and
                year\MessageBreak without distinguishing extra
                letter,\MessageBreak appears as question mark}\fi
                \NAT@hyper@{\NAT@exlab}%
              \else
                \unskip\NAT@spacechar
                \NAT@hyper@{\NAT@date}%
              \fi
          \else
            \@citea\NAT@hyper@{%
              \NAT@nmfmt{\NAT@nm}%
              \hyper@natlinkbreak{\NAT@spacechar\NAT@@open\if*#1*\else#1\NAT@spacechar\fi}%
                {\@citeb\@extra@b@citeb}%
              \NAT@date
            }%
          \fi
          \fi
        \or\@citea\NAT@hyper@{\NAT@nmfmt{\NAT@nm}}%
        \or\@citea\NAT@hyper@{\NAT@date}%
        \or\@citea\NAT@hyper@{\NAT@alias}%
        \fi
        \if\relax\NAT@date\relax
          \NAT@def@citea
        \else
          \NAT@def@citea@close
        \fi
      \fi
      }}\ifNAT@swa\else
        % \if*#2*\else\NAT@cmt#2\fi
        \if\relax\NAT@date\relax\else\NAT@@close\fi
        \if*#2*\else\textsuperscript{#2}\fi
      \fi}{#1}{#2}}
  \renewcommand\bibsection{\thu@bib@heading{\bibname}}
  \newcommand\thu@set@bibliography@format{%
    \renewcommand\bibfont{\fontsize{10.5bp}{16bp}\selectfont}%
    \setlength{\bibsep}{3bp \@plus 3bp \@minus 3bp}%
    \ifthu@degree@bachelor
      \ifthu@main@language@chinese
        \setlength{\bibhang}{21bp}%  2em
      \else
        \renewcommand\bibfont{\fontsize{10.5bp}{17bp}\selectfont}%
        \setlength{\bibsep}{6bp \@plus 3bp \@minus 3bp}%
        \setlength{\bibhang}{0.5in}%
      \fi
    \else
      \setlength{\bibhang}{21bp}%  2em
    \fi
  }
  \thu@set@bibliography@format
  \thu@option@hook{degree}{\thu@set@bibliography@format}
  \thu@option@hook{main-language}{\thu@set@bibliography@format}
  \patchcmd\thebibliography{%
    \clubpenalty4000%
  }{%
    \interlinepenalty=5000\relax
    \clubpenalty=10000\relax
  }{}{\thu@patch@error{\thebibliography}}
  \patchcmd\thebibliography{%
    \widowpenalty4000%
  }{%
    \widowpenalty=10000\relax
  }{}{\thu@patch@error{\thebibliography}}
  \def\@biblabel#1{[#1]\hfill}
  \renewcommand\NAT@bibsetnum[1]{%
    % \settowidth\labelwidth{\@biblabel{#1}}%
    % \setlength{\leftmargin}{\labelwidth}%
    % \addtolength{\leftmargin}{\labelsep}%
    \setlength{\labelwidth}{1cm}%
    \setlength{\leftmargin}{\labelwidth}%
    \setlength{\labelsep}{\z@}%
    \setlength{\itemsep}{\bibsep}%
    \setlength{\parsep}{\z@}%
    \ifNAT@openbib
      \addtolength{\leftmargin}{\bibindent}%
      \setlength{\itemindent}{-\bibindent}%
      \setlength{\listparindent}{\itemindent}%
      \setlength{\parsep}{0pt}%
    \fi
  }
}
\AtEndOfPackageFile*{biblatex}{
  \AtBeginDocument{
    \ifthenelse{\equal{\blx@bbxfile}{apa}}{\def\bibname{REFERENCES}}{}
    \ifthenelse{\equal{\blx@bbxfile}{apa6}}{\def\bibname{REFERENCES}}{}
    \ifthenelse{\equal{\blx@bbxfile}{mla}}{\def\bibname{WORKS CITED}}{}
    \ifthenelse{\equal{\blx@bbxfile}{mla-new}}{\def\bibname{WORKS CITED}}{}
  }
  \DeclareRobustCommand\inlinecite{\parencite}
  \defbibheading{bibliography}[\bibname]{\thu@bib@heading{#1}}
  \newcommand\thu@set@bibliography@format{%
    \renewcommand\bibfont{\fontsize{10.5bp}{16bp}\selectfont}%
    \setlength{\bibitemsep}{3bp \@plus 3bp \@minus 3bp}%
    % 在 .bbx 中设置 \labelwidth 为 1 cm，\labelsep 为 0 pt。
    \setlength{\biblabelsep}{0pt}%
    \ifthu@degree@bachelor
      \ifthu@main@language@chinese
        \setlength{\bibhang}{21bp}%  2em
      \else
        \renewcommand\bibfont{\fontsize{10.5bp}{17bp}\selectfont}%
        \setlength{\bibitemsep}{6bp \@plus 3bp \@minus 3bp}%
        \setlength{\bibhang}{0.5in}%
      \fi
    \else
      \setlength{\bibhang}{21bp}%  2em
    \fi
  }
  \thu@set@bibliography@format
  \thu@option@hook{degree}{\thu@set@bibliography@format}
  \thu@option@hook{main-language}{\thu@set@bibliography@format}
}
\AtEndOfPackageFile*{apacite}{
  \AtBeginDocument{
    \thu@set@chapter@names
  }
  \renewcommand\bibliographytypesize{\fontsize{10.5bp}{16bp}\selectfont}
  \setlength{\bibitemsep}{3bp \@plus 3bp \@minus 3bp}%
  \ifthu@degree@bachelor
    \ifthu@main@language@english
      \renewcommand\bibliographytypesize{\fontsize{10.5bp}{17bp}\selectfont}%
      \setlength{\bibitemsep}{6bp \@plus 3bp \@minus 3bp}%
    \fi
  \fi
  \ifthu@main@language@chinese
    \setlength{\bibleftmargin}{1cm}
    \setlength{\bibindent}{-\bibleftmargin}
  \else
    \setlength{\bibleftmargin}{0.5in}
    \setlength{\bibindent}{-\bibleftmargin}
  \fi
  \def\st@rtbibchapter{%
    \if@numberedbib%
      \chapter{\bibname}%   e.g.,   6. References
    \else%
      \thu@chapter*{\bibname}%   e.g.,   References
    \fi%
  }%
}
\g@addto@macro\appendix{%
  \@mainmattertrue
}
\thu@define@key{
  toc-depth = {
    name = toc@depth,
  },
}
\thu@option@hook{toc-depth}{%
  \ifx\@begindocumenthook\@undefined
    \protected@write\@auxout{}{%
      \string\ttl@writefile{toc}{%
        \protect\setcounter{tocdepth}{\thu@toc@depth}%
      }%
    }%
  \else
    \setcounter{tocdepth}{\thu@toc@depth}%
  \fi
}
\g@addto@macro\appendix{%
  \thusetup{
    toc-depth = 0,
  }%
}
\thu@define@key{
  appendix-figure-in-lof = {
    name = appendix@figure@in@lof,
    choices = {
      true,
      false,
    },
    default = false,
  },
}
\thu@option@hook{appendix-figure-in-lof}{%
  \ifthu@appendix@figure@in@lof@true
    \addtocontents{lof}{\string\let\string\contentsline\string\ttl@contentsline}%
    \addtocontents{lot}{\string\let\string\contentsline\string\ttl@contentsline}%
    \addtocontents{loe}{\string\let\string\contentsline\string\ttl@contentsline}%
  \else
    \addtocontents{lof}{\string\let\string\contentsline\string\ttl@gobblecontents}%
    \addtocontents{lot}{\string\let\string\contentsline\string\ttl@gobblecontents}%
    \addtocontents{loe}{\string\let\string\contentsline\string\ttl@gobblecontents}%
  \fi
}
\g@addto@macro\appendix{%
  \thusetup{
    appendix-figure-in-lof = false,
  }%
}
\newcommand\thu@appendix@bib@heading[1]{%
  \begingroup
    \ctexset{section/numbering = false}%
    \ifthu@degree@bachelor
      \ctexset{section = {
        format = \centering\fontsize{12bp}{14.4bp}\selectfont,
        beforeskip = 66bp,
        afterskip = 4bp,
      }}%
    \fi
    \section{#1}%
  \endgroup
}
\g@addto@macro\appendix{%
  \let\thu@bib@heading\thu@appendix@bib@heading
}
\newcommand\thu@end@appendix@ref@section{}
\AtBeginOfPackageFile*{bibunits}{
  \def\bibliography#1{%
    \if@filesw
      \immediate\write\@auxout{\string\bibdata{\zap@space#1 \@empty}}%
      \immediate\write\@auxout{\string\gdef\string\bu@bibdata{#1}}%
    \fi
    \@input@{\jobname.bbl}%
    \gdef\bu@bibdata{#1}%
  }
  \def\bibliographystyle#1{%
    \ifx\@begindocumenthook\@undefined\else
      \expandafter\AtBeginDocument
    \fi
      {\if@filesw
        \immediate\write\@auxout{\string\bibstyle{#1}}%
        \immediate\write\@auxout{\string\gdef\string\bu@bibstyle{#1}}%
      \fi}%
      \gdef\bu@bibstyle{#1}%
  }
}
\AtEndOfPackageFile*{bibunits}{
  \def\@startbibunit{%
    \global\let\@startbibunitorrelax\relax
    \global\let\@finishbibunit\@finishstartedbibunit
    \global\advance\@bibunitauxcnt 1
    \if@filesw
      {\endlinechar-1
      \makeatletter
      \@input{\@bibunitname.aux}}%
      \immediate\openout\@bibunitaux\@bibunitname.aux
      \immediate\write\@bibunitaux{\string\bibstyle{\@localbibstyle}}%
    \fi
  }
  \def\bu@bibliography#1{%
    \putbib[#1]%
  }
  \def\bu@bibliographystyle#1{%
    \if@filesw
      \immediate\write\@bibunitaux{\string\gdef\string\@localbibstyle{#1}}%
    \fi
    \gdef\@localbibstyle{#1}%
  }
  \providecommand\printbibliography{\putbib\relax}%
  \g@addto@macro\appendix{%
    \renewcommand\@bibunitname{\jobname-appendix-\@alph\c@chapter}%
    \bibliographyunit[\chapter]%
    \renewcommand\@extra@binfo{@-\@alph\c@chapter}%
    \renewcommand\@extra@b@citeb{@-\@alph\c@chapter}%
    \ifthu@degree@bachelor\else
      \renewcommand\citenumfont{\@Alph\c@chapter.}%
      \renewcommand\bibnumfmt[1]{[\@Alph\c@chapter.#1]\hfill}%
    \fi
  }
  \renewcommand\thu@end@appendix@ref@section{%
    \bibliographyunit\relax
  }
  \AtEndDocument{\thu@end@appendix@ref@section}
  % \let\@xtestdef\@gobbletwo  % This doesn't work
  \def\bibunits@rerun@warning{\relax}
}
\PassOptionsToPackage{defernumbers=true}{biblatex}
\AtEndOfPackageFile*{biblatex}{
  \DeclareRefcontext{appendix}{labelprefix=\@Alph\c@chapter.}
  \g@addto@macro\appendix{%
    % 参考 biblatex 的 refsection=chapter 选项实现方式，
    % 在 \@makechapterhead 和 \@makeschapterhead 进行 patch
    \pretocmd\@makechapterhead{%
      \newrefsection
      \ifthu@degree@bachelor\else
        \newrefcontext{appendix}%
      \fi
    }{}{\thu@patch@error{\@makechapterhead}}%
    \pretocmd\@makeschapterhead{%
      \newrefsection
      \ifthu@degree@bachelor\else
        \newrefcontext{appendix}%
      \fi
    }{}{\thu@patch@error{\@makeschapterhead}}%
  }
  \def\bibliographystyle#1{%
    \thu@warning{'bibliographystyle' invalid for 'biblatex'.}%
  }
}
\@ifpackagelater{titletoc}{2019/07/14}{
  \newcommand\thu@print@contents[5]{%
    \printcontents[#1]{#2}{#3}[#4]{}%
  }
}{
  \newcommand\thu@print@contents[5]{%
    \printcontents[#1]{#2}{#3}{\setcounter{tocdepth}{#4}#5}%
  }
}
\newenvironment{survey}{%
  \thu@deprecate{"survey" environment}{}%
  \chapter{外文资料的调研阅读报告}%
  \thusetup{language = english}%
  \let\title\@gobble
  \let\maketitle\relax
  \let\tableofcontents\relax
  \let\appendix\relax
  \renewcommand\bibname{参考文献}%
}{%
  \thu@reset@main@language % restore language
}
\newenvironment{translation}{%
  \thu@deprecate{"translation" environment}{}%
  \chapter{外文资料的书面翻译}%
  \thusetup{language = chinese}%
  \let\title\@gobble
  \let\maketitle\relax
  \renewenvironment{abstract}{%
    \ctexset{
      section = {
        format    += \centering,
        numbering  = false,
      },
    }%
    \section{摘要}%
  }{%
    \par
    \ifx\thu@keywords\@empty\else
      \textbf{关键词：}\thu@clist@use{\thu@keywords}{；}\par
    \fi
  }%
  \let\tableofcontents\relax
  \let\appendix\relax
}{%
  \thu@reset@main@language % restore language
}
\NewEnviron{translation-index}{%
  \thu@deprecate{"translation-index" environment}{}%
}{}
\newenvironment{resume}{%
  \@mainmatterfalse
  \thu@end@appendix@ref@section
  \thu@chapter*{\thu@resume@name}%
  \ctexset{section/numbering = false}%
  \ifthu@degree@bachelor
    \ctexset{section/aftertitle = {：\@@par}}%
  \else
    \ctexset{section/format += \centering}%
  \fi
  \ifthu@language@chinese
    \ctexset{
      subsection = {
        format     = \sffamily\fontsize{14bp}{20bp}\selectfont,
        numbering  = false,
        aftertitle = {：\@@par},
      },
    }%
    \setlist[achievements]{
      topsep     = 6bp,
      itemsep    = 6bp,
      leftmargin = 1cm,
      labelwidth = 1cm,
      labelsep   = 0pt,
      first      = {
        \ifthu@degree@graduate
          \fontsize{12bp}{16bp}\selectfont
        \fi
      },
      align      = left,
      label      = [\arabic*],
      resume     = achievements,
    }%
  \else
    \ctexset{
      subsection = {
        beforeskip = 0pt,
        afterskip  = 0pt,
        format     = \bfseries\normalsize,
        indent     = \parindent,
        numbering  = false,
      },
    }%
    \ifthu@degree@bachelor
      % 内容部分用Arial字体，字号15pt，行距采用固定值20pt， 段前后 0pt。
      \sffamily\fontsize{15bp}{20bp}\selectfont
    \fi
    \setlist[achievements]{
      topsep     = 0bp,
      itemsep    = 0bp,
      leftmargin = 1.75cm,
      labelsep   = 0.5cm,
      align      = right,
      label      = [\arabic*],
      resume     = achievements,
    }%
  \fi
}{}
\newcommand\resumeitem[1]{%
  \thu@error{The "\protect\resumeitem" is obsolete. Please update to the new format}%
}
\newcommand\researchitem[1]{%
  \thu@error{The "\protect\researchitem" is obsolete. Please update to the new format}%
}
\newlist{achievements}{enumerate}{1}
\setlist[achievements]{
  topsep     = 6bp,
  partopsep  = 0bp,
  itemsep    = 6bp,
  parsep     = 0bp,
  leftmargin = 10mm,
  itemindent = 0pt,
  align      = left,
  label      = [\arabic*],
  resume     = achievements,
}
\newenvironment{publications}{%
  \thu@deprecate{"publications" environment}{"achievements"}%
  \begin{achievements}%
}{%
  \end{achievements}%
}
\newcommand\publicationskip{%
  \thu@error{The "\protect\publicationskip" is obsolete. Do not use it}%
}
\NewEnviron{comments}[1][]{%
  \thu@end@appendix@ref@section
  \ifthu@degree@graduate
    \@mainmatterfalse
    \kv@define@key{thu@comments}{name}{\let\thu@comments@name\kv@value}%
    \kv@set@family@handler{thu@comments}{%
      \ifx\kv@value\relax
        \let\thu@comments@name\kv@key
      \else
        \kv@handled@false
      \fi
    }%
    \kvsetkeys{thu@comments}{#1}%
    \chapter{\thu@comments@name}%
    \BODY\clearpage
  \fi
}
\NewEnviron{resolution}{%
  \thu@end@appendix@ref@section
  \ifthu@degree@graduate
    \@mainmatterfalse
    \chapter{\thu@resolution@name}%
    \BODY\clearpage
  \fi
}
\newcommand{\record}[1]{%
  \ifthu@degree@bachelor
    \let\thu@record@file\@empty
    \kv@define@key{thu@record}{file}{\let\thu@record@file\kv@value}%
    \kv@set@family@handler{thu@record}{%
      \ifx\kv@value\relax
        \let\thu@record@file\kv@key
      \else
        \kv@handled@false
      \fi
    }%
    \kvsetkeys{thu@record}{#1}%
    \ifx\thu@record@file\@empty
      \thu@error{File path of \protect\record\space is required}
    \fi
    \clearpage
    \thu@pdfbookmark{0}{综合论文训练记录表}%
    \includepdf[pages=-]{\thu@record@file}%
  \fi
  \thu@replace@with@error{record}
}
\PassOptionsToPackage{
  linktoc            = all,
  bookmarksdepth     = 2,
  bookmarksnumbered  = true,
  bookmarksopen      = true,
  bookmarksopenlevel = 1,
  bookmarksdepth     = 3,
  unicode            = true,
  psdextra           = true,
  breaklinks         = true,
  plainpages         = false,
  pdfdisplaydoctitle = true,
  hidelinks,
}{hyperref}
\AtEndOfPackageFile*{hyperref}{
  \newcounter{thu@bookmark}
  \renewcommand\thu@pdfbookmark[2]{%
    \phantomsection
    \stepcounter{thu@bookmark}%
    \pdfbookmark[#1]{#2}{thuchapter.\thethu@bookmark}%
  }
  \renewcommand\thu@phantomsection{%
    \phantomsection
  }
  \pdfstringdefDisableCommands{%
    \let\\\relax
    \let\quad\relax
    \let\qquad\relax
    \let\hspace\@gobble
  }%
  \@ifpackagelater{hyperref}{2019/04/27}{}{%
    \g@addto@macro\psdmapshortnames{\let\mu\textmu}
  }%
  \ifthu@main@language@chinese
    \hypersetup{
      pdflang = zh-CN,
    }%
  \else
    \hypersetup{
      pdflang = en-US,
    }%
  \fi
  \AtBeginDocument{%
    \ifthu@main@language@chinese
      \hypersetup{
        pdftitle    = \thu@title,
        pdfauthor   = \thu@author,
        pdfsubject  = \thu@discipline,
        pdfkeywords = \thu@keywords,
      }%
    \else
      \hypersetup{
        pdftitle    = \thu@title@en,
        pdfauthor   = \thu@author@en,
        pdfsubject  = \thu@discipline@en,
        pdfkeywords = \thu@keywords@en,
      }%
    \fi
    \hypersetup{
      pdfcreator={\thuthesis-v\version}}
  }%
}
\AtEndOfPackageFile*{mathtools}{
  \@ifpackageloaded{unicode-math}{
    \let\underbrace\LaTeXunderbrace
    \let\overbrace\LaTeXoverbrace
  }{}
  \expandafter\def\csname MT_extended_eqref:n\endcsname#1{%
    \ifthu@language@chinese
      \ifthu@eqn@paren@style@full
        \unskip
      \fi
    \fi
    \protected@write\@auxout{}
      {\string\MT@newlabel{#1}}%
    \textup{\let\df@label\@empty\csname MT_prev_tagform:n\endcsname{\ref{#1}}}%
    \ifthu@language@chinese
      \ifthu@eqn@paren@style@full
        \ignorespaces
      \fi
    \fi
  }
  \expandafter\MakeRobust\csname MT_extended_eqref:n\endcsname
}
\PassOptionsToPackage{notocbasic}{nomencl}
\AtEndOfPackageFile*{nomencl}{
  \let\nomname\thu@denotation@name
  \def\thenomenclature{\begin{denotation}[\nom@tempdim]}
  \def\endthenomenclature{\end{denotation}}
}
\AtEndOfPackageFile*{siunitx}{%
  \newcommand\thu@set@siunitx@language{%
    \ifthu@language@chinese
      \sisetup{
        list-final-separator = {\TextOrMath{\space}{\ }\text{和}\TextOrMath{\space}{\ }},
        list-pair-separator  = {\TextOrMath{\space}{\ }\text{和}\TextOrMath{\space}{\ }},
        range-phrase         = {\text{～}},
      }%
    \else
      \ifthu@language@english
        \sisetup{
          list-final-separator = {\TextOrMath{\space}{\ }\text{and}\TextOrMath{\space}{\ }},
          list-pair-separator  = {\TextOrMath{\space}{\ }\text{and}\TextOrMath{\space}{\ }},
          range-phrase         = {\TextOrMath{\space}{\ }\text{to}\TextOrMath{\space}{\ }},
        }%
      \fi
    \fi
  }
  \thu@set@siunitx@language
  \thu@option@hook{language}{\thu@set@siunitx@language}
}
\AtEndOfPackageFile*{amsthm}{%
  \newtheoremstyle{thu}
    {\z@}{\z@}
    {\normalfont}{\z@}
    {\normalfont\sffamily}{\thu@theorem@separator}
    {0.5em}{}
  \theoremstyle{thu}
  \newtheorem{assumption}{\thu@assumption@name}[chapter]%
  \newtheorem{definition}{\thu@definition@name}[chapter]%
  \newtheorem{proposition}{\thu@proposition@name}[chapter]%
  \newtheorem{lemma}{\thu@lemma@name}[chapter]%
  \newtheorem{theorem}{\thu@theorem@name}[chapter]%
  \newtheorem{axiom}{\thu@axiom@name}[chapter]%
  \newtheorem{corollary}{\thu@corollary@name}[chapter]%
  \newtheorem{exercise}{\thu@exercise@name}[chapter]%
  \newtheorem{example}{\thu@example@name}[chapter]%
  \newtheorem{remark}{\thu@remark@name}[chapter]%
  \newtheorem{problem}{\thu@problem@name}[chapter]%
  \newtheorem{conjecture}{\thu@conjecture@name}[chapter]%
  \renewenvironment{proof}[1][\thu@proof@name]{\par
    \pushQED{\qed}%
    % \normalfont \topsep6\p@\@plus6\p@\relax
    \normalfont \topsep\z@\relax
    \trivlist
    \item[\hskip\labelsep
      %     \itshape
      % #1\@addpunct{.}]\ignorespaces
      \sffamily
      #1]\ignorespaces
  }{%
    \popQED\endtrivlist\@endpefalse
  }
  \renewcommand\qedsymbol{\thu@qed}
}
\AtEndOfPackageFile*{ntheorem}{%
  \theorembodyfont{\normalfont}%
  \theoremheaderfont{\normalfont\sffamily}%
  \theoremsymbol{\thu@qed}%
  \newtheorem*{proof}{\thu@proof@name}%
  \theoremstyle{plain}%
  \theoremsymbol{}%
  \theoremseparator{\thu@theorem@separator}%
  \newtheorem{assumption}{\thu@assumption@name}[chapter]%
  \newtheorem{definition}{\thu@definition@name}[chapter]%
  \newtheorem{proposition}{\thu@proposition@name}[chapter]%
  \newtheorem{lemma}{\thu@lemma@name}[chapter]%
  \newtheorem{theorem}{\thu@theorem@name}[chapter]%
  \newtheorem{axiom}{\thu@axiom@name}[chapter]%
  \newtheorem{corollary}{\thu@corollary@name}[chapter]%
  \newtheorem{exercise}{\thu@exercise@name}[chapter]%
  \newtheorem{example}{\thu@example@name}[chapter]%
  \newtheorem{remark}{\thu@remark@name}[chapter]%
  \newtheorem{problem}{\thu@problem@name}[chapter]%
  \newtheorem{conjecture}{\thu@conjecture@name}[chapter]%
}
\PassOptionsToPackage{chapter}{algorithm}
\AtEndOfPackageFile*{algorithm}{
  \floatname{algorithm}{\thu@algorithm@name}
  \renewcommand\listofalgorithms{%
    \thu@listof{algorithm}%
  }
  \renewcommand\listalgorithmname{\thu@list@algorithm@name}
  \def\ext@algorithm{loa}
  \contentsuse{algorithm}{loa}
  \titlecontents{algorithm}
    [\z@]{}
    {\contentspush{\fname@algorithm~\thecontentslabel\thu@contents@label@delimiter}}{}
    {\thu@leaders\thecontentspage}
}
\PassOptionsToPackage{algochapter}{algorithm2e}
\AtEndOfPackageFile*{algorithm2e}{
  \renewcommand\algorithmcfname{\thu@algorithm@name}
  \SetAlgoCaptionLayout{thu@caption@font}
  \SetAlCapSty{relax}
  \SetAlgoCaptionSeparator{\hspace*{1em}}
  \SetAlFnt{\fontsize{11bp}{14.3bp}\selectfont}
  \renewcommand\listofalgorithms{%
    \thu@listof{algorithmcf}%
  }
  \renewcommand\listalgorithmcfname{\thu@list@algorithm@name}
  \def\ext@algorithmcf{loa}
  \contentsuse{algocf}{loa}
  \titlecontents{algocf}
    [\z@]{}
    {\contentspush{\algorithmcfname~\thecontentslabel\thu@contents@label@delimiter}}{}
    {\thu@leaders\thecontentspage}
}
\AtEndOfPackageFile*{minted}{
  \newcommand\thu@set@listing@language{%
    \ifthu@language@chinese
      \floatname{listing}{代码}%
    \else
      \floatname{listing}{Listing}%
    \fi
  }
  \thu@set@listing@language
  \thu@option@hook{language}{\thu@set@listing@language}
}
\thu@define@key{
  spine-font = {
    name = spine@font,
  },
  spine-title = {
    name = spine@title,
  },
  spine-author = {
    name = spine@author,
  },
}
\renewcommand\thu@spine@font{%
  \ifthu@degree@doctor
    \fontsize{16bp}{20.8bp}\selectfont
  \else
    \fontsize{15bp}{19.5bp}\selectfont
  \fi
}
\newcommand*\CJKmovesymbol[1]{\raise.3em\hbox{#1}}
\newcommand*\CJKmove{%
  \punctstyle{plain}%
  \let\CJKsymbol\CJKmovesymbol
  \let\CJKpunctsymbol\CJKsymbol
}
\NewDocumentCommand{\spine}{
    O{
      \ifx\thu@spine@title\@empty
        \thu@title
      \else
        \thu@spine@title
      \fi
    }
    O{
      \ifx\thu@spine@author\@empty
        \thu@author
      \else
        \thu@spine@author
      \fi
    }}{%
  \clearpage
  \ifthu@degree@bachelor
    \newgeometry{
      vmargin = 3cm,
      hmargin = 1cm,
    }%
  \else
    \newgeometry{
      vmargin = 5.5cm,
      hmargin = 1cm,
    }%
  \fi
  \thispagestyle{empty}%
  \ifthu@main@language@chinese
    \thu@pdfbookmark{0}{书脊}%
  \else
    \thu@pdfbookmark{0}{Spine}%
  \fi
  \begingroup
    \noindent\hfill
    \rotatebox[origin=lt]{-90}{%
      \makebox[\textheight]{%
        \fangsong
        \addCJKfontfeatures*{RawFeature={vertical}}%
        \thu@spine@font
        \CJKmove
        #1\hfill
        \thu@stretch{4.5em}{#2}%
      }%
    }%
  \endgroup
  \clearpage
  \restoregeometry
}
\DeclareRobustCommand\cs[1]{\texttt{\char`\\#1}}
\DeclareRobustCommand\file{\nolinkurl}
\DeclareRobustCommand\env{\textsf}
\DeclareRobustCommand\pkg{\textsf}
\DeclareRobustCommand\cls{\textsf}
\sloppy
\endinput
%%
%% End of file `thuthesis.cls'.
