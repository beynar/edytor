import { formatText } from "../../..";
import { makeEditorFixture } from "../../fixture/editorFixture";

test("format on two formated leaves", () => {
  const initialValue = [
    {
      type: "paragraph",
      content: [
        {
          text: "Lorem",
          bold: true
        },
        {
          text: " ipsum",
          italic: true
        }
      ],
      children: []
    }
  ];

  const expectedValue = [
    {
      type: "paragraph",
      content: [
        {
          text: "Lorem",
          bold: true,
          code: true
        },
        {
          text: " ipsum",
          italic: true,
          code: true
        }
      ],
      children: []
    }
  ];

  const editor = makeEditorFixture(initialValue, {
    start: { path: [0, 0], offset: 0 },
    end: { path: [0, 1], offset: 6 }
  });
  formatText(editor, { code: true });
  console.log(JSON.stringify(editor.toJSON(), null, 2));
  expect(editor.toJSON()).toStrictEqual(expectedValue);
});

test("format on two formated leaves that should be merged after", () => {
  const initialValue = [
    {
      type: "paragraph",
      content: [
        {
          text: "Lorem",
          bold: true,
          italic: true
        },
        {
          text: " ipsum",
          italic: true
        }
      ],
      children: []
    }
  ];

  const expectedValue = [
    {
      type: "paragraph",
      content: [
        {
          text: "Lorem ipsum",
          bold: true,
          italic: true
        }
      ],
      children: []
    }
  ];

  const editor = makeEditorFixture(initialValue, {
    start: { path: [0, 0], offset: 0 },
    end: { path: [0, 1], offset: 6 }
  });
  formatText(editor, { bold: true });
  console.log(JSON.stringify(editor.toJSON(), null, 2));
  expect(editor.toJSON()).toStrictEqual(expectedValue);
});

test("unformat on two formated leaves that both shared the same format wich should be removed", () => {
  const initialValue = [
    {
      type: "paragraph",
      content: [
        {
          text: "Lorem",
          bold: true,
          italic: true
        },
        {
          text: " ipsum",
          italic: true
        }
      ],
      children: []
    }
  ];

  const expectedValue = [
    {
      type: "paragraph",
      content: [
        {
          text: "Lorem",
          bold: true
        },
        {
          text: " ipsum"
        }
      ],
      children: []
    }
  ];

  const editor = makeEditorFixture(initialValue, {
    start: { path: [0, 0], offset: 0 },
    end: { path: [0, 1], offset: 6 }
  });
  formatText(editor, { italic: true });
  console.log(JSON.stringify(editor.toJSON(), null, 2));
  expect(editor.toJSON()).toStrictEqual(expectedValue);
});

test("format three nodes", () => {
  const initialValue = [
    {
      type: "paragraph",
      content: [
        {
          text: "Lorem",
          bold: true,
          italic: true
        },
        {
          text: " ipsum",
          italic: true
        },
        {
          text: " dolor",
          code: true
        }
      ],
      children: []
    }
  ];

  const expectedValue = [
    {
      type: "paragraph",
      content: [
        {
          text: "Lorem",
          bold: true,
          italic: true,
          st: true
        },
        {
          text: " ipsum",
          italic: true,
          st: true
        },
        {
          text: " dolor",
          code: true,
          st: true
        }
      ],
      children: []
    }
  ];

  const editor = makeEditorFixture(initialValue, {
    start: { path: [0, 0], offset: 0 },
    end: { path: [0, 2], offset: 6 }
  });
  formatText(editor, { st: true });
  console.log(JSON.stringify(editor.toJSON(), null, 2));
  expect(editor.toJSON()).toStrictEqual(expectedValue);
});

test("format three nodes while", () => {
  const initialValue = [
    {
      type: "paragraph",
      content: [
        {
          text: "Lorem",
          bold: true,
          italic: true
        },
        {
          text: " ipsum",
          italic: true
        },
        {
          text: " dolor",
          code: true
        }
      ],
      children: []
    }
  ];

  const expectedValue = [
    {
      type: "paragraph",
      content: [
        {
          text: "Lorem",
          bold: true,
          italic: true,
          st: true
        },
        {
          text: " ipsum",
          italic: true,
          st: true
        },
        {
          text: " dolor",
          code: true,
          st: true
        }
      ],
      children: []
    }
  ];

  const editor = makeEditorFixture(initialValue, {
    start: { path: [0, 0], offset: 0 },
    end: { path: [0, 2], offset: 6 }
  });
  formatText(editor, { st: true });
  expect(editor.toJSON()).toStrictEqual(expectedValue);
});

test("format three nodes while breaking them", () => {
  const initialValue = [
    {
      type: "paragraph",
      content: [
        {
          text: "Lorem",
          bold: true,
          italic: true
        },
        {
          text: " ipsum",
          italic: true
        },
        {
          text: " dolor",
          code: true
        }
      ],
      children: []
    }
  ];

  const expectedValue = [
    {
      type: "paragraph",
      content: [
        {
          text: "L",
          bold: true,
          italic: true
        },
        {
          text: "orem",
          bold: true,
          italic: true,
          st: true
        },
        {
          text: " ipsum",
          italic: true,
          st: true
        },
        {
          text: " dolo",
          code: true,
          st: true
        },
        {
          text: "r",
          code: true
        }
      ],
      children: []
    }
  ];

  const editor = makeEditorFixture(initialValue, {
    start: { path: [0, 0], offset: 1 },
    end: { path: [0, 2], offset: 5 }
  });
  formatText(editor, { st: true });
  console.log(JSON.stringify(editor.toJSON(), null, 2));
  expect(editor.toJSON()).toStrictEqual(expectedValue);
});
