#!/usr/bin/env python3
"""The GLES shader rewriting of orthros-r2.patch (glesrewrite.hpp: plain scans) against the std::regex code it replaces
(the pinned source's shadermanager.cpp), natively: both compiled with clang++ into one program, which runs every
shader of the engine's files/shaders (whole, as vertex and as fragment shaders, and their concatenations as the
engine's $link merging makes them) and generated sources through both and fails on the first difference; then the
same for $link statements. It also times both over the merged sources.
Usage: python3 tools/openmw/gles-rewrite-check.py [--engines-dir <dir>] [--scratch <dir>]
"""
import argparse, json, pathlib, re, shutil, subprocess, sys

here = pathlib.Path(__file__).resolve().parent
root = here.parent.parent
ap = argparse.ArgumentParser()
ap.add_argument('--engines-dir', default=str(root / 'data_engines'))
ap.add_argument('--scratch', default='/tmp/orthros-scratch/openmw-gles-rewrite-check')
a = ap.parse_args()
lock = json.loads((here / 'lock.json').read_text())
source = pathlib.Path(a.engines_dir) / 'src' / lock['id'] / f"openmw-web-{lock['tag']}" / 'openmw'
scratch = pathlib.Path(a.scratch)
shutil.rmtree(scratch, ignore_errors=True)
(scratch / 'tree').mkdir(parents=True)

# The patched files: the pinned source's, with the r2 patch applied in a scratch tree (only the files it touches here)
patch = here / 'patches' / 'orthros-r2.patch'
tree = scratch / 'tree'
(tree / 'openmw/components/shader').mkdir(parents=True)
shutil.copy2(source / 'components/shader/shadermanager.cpp', tree / 'openmw/components/shader/shadermanager.cpp')
subprocess.run(['git', 'apply', '--whitespace=nowarn', '--include=openmw/components/shader/*', str(patch)], cwd=tree, check=True)
old = (source / 'components/shader/shadermanager.cpp').read_text()
new = (tree / 'openmw/components/shader/shadermanager.cpp').read_text()


def function(text, start):
    i = text.index(start)
    j = text.index('\n    }\n', i) + len('\n    }\n')
    return text[i:j]


def link(text):
    """parseLinkDirective's statement parsing, as a function of the statement."""
    body = function(text, '    bool parseLinkDirective(')
    a = body.index('        size_t lineEnd')
    b = body.index('        if (linkTarget.empty())')
    return body[a:b]


old_adjust = function(old, '    void adjustSourceForGLES(')
new_adjust = function(new, '    void adjustSourceForGLES(')
assert 'std::regex_' in old_adjust and not re.search(r'std::regex[_(]', new_adjust)
harness = f'''
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <random>
#include <regex>
#include <sstream>
#include <string>
#include <vector>
#include "glesrewrite.hpp"
namespace osg {{ struct Shader {{ enum Type {{ VERTEX, FRAGMENT }}; }}; }}
namespace Debug {{ enum Level {{ Error }}; }}
struct NullLog {{ template <class T> NullLog& operator<<(const T&) {{ return *this; }} }};
#define Log(x) NullLog()
namespace Old {{
{old_adjust}
    bool parseLink(std::string source, std::string& linkTarget, bool& condition, const std::string& templateName)
    {{
        size_t foundPos = 0, endPos = 5;
{link(old)}
        condition = hasCondition ? !(linkConditionExpression.empty() || linkConditionExpression == "0") != (linkMatch[3].str() == "!") : true;
        return true;
    }}
}}
namespace New {{
{new_adjust}
    bool parseLink(std::string source, std::string& linkTarget, bool& condition, const std::string& templateName)
    {{
        size_t foundPos = 0, endPos = 5;
{link(new)}
        condition = hasCondition ? !(linkConditionExpression.empty() || linkConditionExpression == "0") != negated : true;
        return true;
    }}
}}
static std::string readAll(const char* p) {{ std::ifstream f(p, std::ios::binary); std::stringstream s; s << f.rdbuf(); return s.str(); }}
static int failures = 0;
static void same(const std::string& in, osg::Shader::Type t, const char* what)
{{
    std::string a = in, b = in;
    Old::adjustSourceForGLES(a, t);
    New::adjustSourceForGLES(b, t);
    if (a != b && failures++ < 5)
    {{
        size_t i = 0; while (i < a.size() && i < b.size() && a[i] == b[i]) ++i;
        std::cerr << "DIFFERENT (" << what << ", type " << t << ") at " << i << ":\\n old: " << a.substr(i > 40 ? i - 40 : 0, 120)
                  << "\\n new: " << b.substr(i > 40 ? i - 40 : 0, 120) << "\\n";
    }}
}}
int main(int argc, char** argv)
{{
    std::vector<std::string> files;
    for (int i = 1; i < argc; ++i) files.push_back(readAll(argv[i]));
    size_t cases = 0;
    for (size_t i = 0; i < files.size(); ++i)
        for (auto t : {{ osg::Shader::VERTEX, osg::Shader::FRAGMENT }}) {{ same(files[i], t, argv[i + 1]); ++cases; }}
    // merged sources, as $link inlining makes them (a shader and the next ones of the list)
    std::vector<std::string> merged;
    for (size_t i = 0; i < files.size(); ++i)
    {{
        std::string m = files[i];
        for (size_t k = 1; k <= 3; ++k) m += "\\n" + files[(i + k * 7) % files.size()];
        merged.push_back(m);
        for (auto t : {{ osg::Shader::VERTEX, osg::Shader::FRAGMENT }}) {{ same(m, t, "merged"); ++cases; }}
    }}
    // generated: the rewritten names with their neighbours (word characters, spaces, dots, brackets, digits)
    const char* pieces[] = {{ "gl_ModelViewProjectionMatrix", "gl_ModelViewMatrix", "gl_ModelViewMatrixInverse", "gl_ProjectionMatrix",
        "gl_NormalMatrix", "gl_TextureMatrix[", "gl_TextureMatrix", "texture2DLod", "texture2DProjLod", "texture2DProj", "texture2DArray",
        "texture2D", "textureCubeLod", "textureCube", "textureSize2D", "shadow2DProj", "shadow2D", "gl_FrontMaterial", "gl_Fog", "emission",
        "ambient", "diffuse", "specular", "shininess", "color", "start", "end", "scale", "density", "gl_Vertex", "gl_Normal", "gl_Color",
        "gl_MultiTexCoord", "gl_ClipVertex", "attribute", "varying", "gl_FragData[", "gl_FragColor", "ftransform", "#version 120\\n",
        "uniform float x = 1.0;\\n", "#extension GL_EXT_gpu_shader4: require\\n", " ", "  ", "\\t", "\\n", "\\r", "\\v", "\\f", ".", ". ", "(", ")",
        "( )", "[", "]", "0", "1", "7", "12", "_", "a", "Z", "x_", "9", ";", "\\xe9", "//__GLES_PRELUDE__\\n", "$", "@" }};
    std::mt19937 rng(12345);
    for (int n = 0; n < 200000; ++n)
    {{
        std::string s;
        const int len = 1 + rng() % 24;
        for (int k = 0; k < len; ++k) s += pieces[rng() % (sizeof pieces / sizeof *pieces)];
        same(s, rng() % 2 ? osg::Shader::VERTEX : osg::Shader::FRAGMENT, "generated"); ++cases;
    }}
    // $link statements
    const char* lpieces[] = {{ "\\"", "lib/light.glsl", "a", " ", "\\t", "\\r", "if", "if ", "!", "0", "1", "@x", "x_1", "iff", "\\"\\"", "  ", "b" }};
    size_t links = 0;
    for (int n = 0; n < 200000; ++n)
    {{
        std::string s = "$link";
        const int len = 1 + rng() % 9;
        for (int k = 0; k < len; ++k) s += lpieces[rng() % (sizeof lpieces / sizeof *lpieces)];
        std::string ta, tb; bool ca = false, cb = false;
        const bool ra = Old::parseLink(s, ta, ca, "t"), rb = New::parseLink(s, tb, cb, "t");
        ++links;
        if ((ra != rb || (ra && (ta != tb || ca != cb))) && failures++ < 10)
            std::cerr << "LINK DIFFERENT for [" << s << "]: " << ra << " " << ta << " " << ca << " / " << rb << " " << tb << " " << cb << "\\n";
    }}
    // timing over the merged sources
    auto time = [&](auto f) {{
        auto t0 = std::chrono::steady_clock::now();
        for (const auto& m : merged) for (auto t : {{ osg::Shader::VERTEX, osg::Shader::FRAGMENT }}) {{ std::string s = m; f(s, t); }}
        return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count() / (2 * merged.size());
    }};
    size_t bytes = 0; for (const auto& m : merged) bytes += m.size();
    const double to = time(Old::adjustSourceForGLES), tn = time(New::adjustSourceForGLES);
    std::printf("{{\\"cases\\": %zu, \\"links\\": %zu, \\"failures\\": %d, \\"mergedSources\\": %zu, \\"meanMergedBytes\\": %zu, \\"regexMsPerSource\\": %.3f, \\"scanMsPerSource\\": %.4f}}\\n",
        cases, links, failures, merged.size(), bytes / merged.size(), to, tn);
    return failures ? 1 : 0;
}}
'''
(scratch / 'check.cpp').write_text(harness)
shutil.copy2(tree / 'openmw/components/shader/glesrewrite.hpp', scratch / 'glesrewrite.hpp')
subprocess.run(['clang++-18', '-std=c++20', '-O2', '-o', str(scratch / 'check'), str(scratch / 'check.cpp')], check=True)
shaders = sorted(str(p) for p in (source / 'files/shaders').rglob('*') if p.is_file())
r = subprocess.run([str(scratch / 'check'), *shaders])
shutil.rmtree(scratch, ignore_errors=True)
sys.exit(r.returncode)
