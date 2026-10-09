# editor-plugins

에디터 앱(저장소 그래프 뷰어)의 **공식 플러그인 목록**과 그 묶음을 짓는 저장소다.

앱은 언어 서버를 싣지 않는다. 언어마다 플러그인을 설치해 쓰고, 「설정 › 플러그인 › 공식 목록」은 이 저장소 기본 브랜치의
`index.json` 한 파일을 읽는다(`https://raw.githubusercontent.com/RoJaebl/editor-plugins/main/index.json`). 목록이 가리키는 묶음은
크기와 sha256 으로 검증된 뒤에야 설치된다. 플러그인의 모양과 설치 규칙은 앱 저장소의 설계 문서
`docs/superpowers/specs/2026-10-07-plugins-lsp-design.md`(§2 · §3 · §5 · §6.4)가 소유한다.

지금 든 플러그인은 하나다.

| id | 이름 | 하는 일 |
|---|---|---|
| `editor.typescript` | TypeScript · JavaScript | `typescript-language-server` 를 앱의 Node 로 돌린다. 진단 · 설명 · 자동완성 · 정의로 가기 · 참조 찾기. 검사 엔진(tsserver)은 신뢰한 작업 폴더의 `node_modules/typescript` 를 먼저 쓰고, 없으면 플러그인이 받아 둔 판(5.9.3 기본 · 5.4.5)을 쓴다 |

## 자리

```
index.json                         공식 목록 — 생성물(아래 「짓기」)
dist/                              묶음 zip — 생성물
  editor.typescript-1.0.0-any.zip                  플러그인 묶음
  editor.typescript-engine-typescript-5.9.3.zip    엔진(typescript 패키지 하나)
  editor.typescript-engine-typescript-5.4.5.zip
plugins/
  typescript/
    plugin.json                    설명서 — 묶음 뿌리에 그대로 들어간다
    catalog.json                   짓기 설정 — 언어 서버 패키지 · 엔진 판 목록(첫 줄이 기본 판)
    THIRD-PARTY-NOTICES.txt        묶은 언어 서버 안에 든 남의 패키지 라이선스
scripts/build.mjs                  짓기 스크립트
package.json · package-lock.json   짓기에 쓰는 판을 정확히 고정한다
```

플러그인 묶음을 풀면 이렇게 된다.

```
plugin.json
server/tsls.js                     typescript-language-server 를 esbuild 로 묶은 파일 하나(node_modules 없이 돈다)
server/package.json                { "type": "module" } — tsls.js 를 ES 모듈로 읽게 한다
server/LICENSE                     typescript-language-server 의 라이선스
server/THIRD-PARTY-NOTICES.txt
```

엔진 zip 은 `typescript` 패키지 폴더를 **zip 뿌리에 그대로** 담는다. 앱이 그것을 `<캐시>/plugins/<id>/engines/<종류>/<판>/` 에
곧바로 풀고, 설명서의 `${engine:typescript}/lib/tsserver.js` 가 그 자리를 가리키기 때문이다.

## 짓기

```sh
node scripts/build.mjs                 # npm ci → 묶기 → dist/*.zip · index.json
node scripts/build.mjs --skip-install  # node_modules 가 이미 lockfile 대로일 때
```

- Node 20 이상. 받는 것은 npm 레지스트리뿐이고, 판은 `package-lock.json` 에 박혀 있다.
- **같은 입력이면 같은 바이트가 나온다** — zip 항목은 이름 차례, 시각은 1980-01-01, 권한은 0644/0755 둘로 고정한다. 다시 지었는데
  `git diff` 가 비지 않으면 무언가 판이 바뀐 것이다.
- zip 은 앱의 풀기 규칙에 맞춘다: zip64 없음 · deflate 또는 stored 만 · 링크 없음 · 풀어서 200MB · 20,000 항목 이하.
  어긋나면 짓기가 멈춘다.
- 파일 하나가 50MB 를 넘으면 멈춘다. 지금은 GitHub Release 를 쓰지 않고 묶음을 `dist/` 에 커밋해 raw 주소로 내주므로,
  커지면 Release 로 옮겨야 한다(앱은 `github.com` · `objects.githubusercontent.com` · `release-assets.githubusercontent.com` 도 받는다).

**`index.json` 과 `dist/` 는 손으로 고치지 않는다.** 짓기가 매번 통째로 다시 쓴다. 고칠 것은 `plugins/` · `package.json` ·
`scripts/build.mjs` 에서 고치고 다시 짓는다.

## 판 더하기

**엔진 판을 더한다**(예: TypeScript 5.8.3)

1. `package.json` 의 `devDependencies` 에 별칭으로 더한다 — `"typescript-5.8.3": "npm:typescript@5.8.3"`. 판은 정확히 적는다.
2. `npm install --ignore-scripts` 로 `package-lock.json` 을 갱신한다.
3. `plugins/typescript/catalog.json` 의 `engines.typescript` 에 `{ "version": "5.8.3", "package": "typescript-5.8.3" }` 를 더한다.
   **첫 줄이 기본 판**이다 — 기본 판을 바꾸면 `plugin.json` 의 `engineKinds.typescript.default` 도 같은 판으로 바꾼다(다르면 짓기가 멈춘다).
4. `node scripts/build.mjs`.

**언어 서버 판을 올린다**

1. `package.json` 의 `typescript-language-server` 판을 바꾸고 lockfile 을 갱신한다. 그 판의 `engines.node` 가 앱이 받는 Node 와 맞는지 본다.
2. `plugin.json` 의 `version` 을 올린다(같은 판 번호로 다른 묶음을 내지 않는다 — 앱은 판으로 설치 자리를 나눈다).
3. 묶은 패키지 목록이 바뀌었으면 `THIRD-PARTY-NOTICES.txt` 를 고친다.
4. 다시 짓는다. 언어 서버가 런타임에 `../package.json` 을 읽는 자리를 짓기가 판 글자로 바꿔 넣는데, 그 자리를 못 찾으면 멈춘다.

**새 플러그인을 더한다** — `plugins/<이름>/` 에 `plugin.json` 과 `catalog.json` 을 두면 짓기가 함께 묶어 `index.json` 에 올린다.

## 설정

`editor.typescript` 가 언어 서버에 처음부터 주는 설정(`settings.defaults`)과 화면이 바꿀 수 있는 키(`settings.allow`)는 서식 ·
표시 기본값뿐이다 — `typescript.format` · `javascript.format` · `typescript.inlayHints` · `javascript.inlayHints` · `formattingOptions` ·
`completions.completeFunctionCalls`. **프로그램이나 경로를 가리키는 키는 `allow` 에 넣지 않는다**(앱 설계 §6.4). 자동 타입 받기
(`disableAutomaticTypingAcquisition: true`)는 꺼 둔다 — 켜 두면 tsserver 가 npm 을 띄워 네트워크에서 타입을 받는다.

## 라이선스

이 저장소의 묶음은 남의 소프트웨어를 다시 나눠 주는 것이고, 각 라이선스 원문을 묶음 안에 함께 싣는다.

| 무엇 | 라이선스 | 묶음 안 자리 |
|---|---|---|
| typescript-language-server 5.3.0 | Apache-2.0(microsoft/vscode 에서 가져온 부분은 MIT) | 플러그인 묶음 `server/LICENSE` |
| 그 안에 이미 묶여 있던 패키지(commander · vscode-languageserver · semver …) | MIT · ISC · BlueOak-1.0.0 | 플러그인 묶음 `server/THIRD-PARTY-NOTICES.txt` |
| TypeScript 5.9.3 · 5.4.5 | Apache-2.0 | 엔진 묶음 `LICENSE.txt` · `ThirdPartyNoticeText.txt` |

짓기 도구(esbuild, MIT)는 묶음에 들어가지 않는다.
