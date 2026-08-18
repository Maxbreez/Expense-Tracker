(function () {
  "use strict";

  var STORAGE_KEY = "petty-cash-v1";

  var CATEGORIES = [
    { id: "housing", label: "Housing" },
    { id: "food", label: "Food & Dining" },
    { id: "transport", label: "Transport" },
    { id: "shopping", label: "Shopping" },
    { id: "entertainment", label: "Entertainment" },
    { id: "health", label: "Health" },
    { id: "utilities", label: "Utilities" },
    { id: "other", label: "Other" }
  ];
  var catById = {};
  CATEGORIES.forEach(function (c) { catById[c.id] = c; });

  // Falls back to "other" for an unrecognized id so a swatch class always resolves.
  function catSlug(id) {
    return (catById[id] || catById.other).id;
  }

  // ---------- input sanitizing ----------
  // Every value that reaches state, storage, or the DOM funnels through these,
  // whether it came from the form, a tampered/hand-edited localStorage record,
  // or a future import feature. Text is always rendered via textContent
  // elsewhere (never innerHTML with user data), so this layer's job is data
  // integrity — trimmed, bounded, correctly-typed values — not script-escaping.
  var MAX_DESC_LEN = 80;
  var MAX_AMOUNT = 100000000; // GH₵100,000,000 sanity ceiling
  var MIN_YEAR = 2000;
  var MAX_YEAR = 2100;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function cleanText(value, maxLen) {
    if (typeof value !== "string") return "";
    // strip ASCII control chars and zero-width/BOM characters, collapse whitespace, trim, cap length
    var controlAndInvisible = new RegExp(
      "[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) +
      String.fromCharCode(127) +
      String.fromCharCode(8203) + "-" + String.fromCharCode(8205) +
      String.fromCharCode(65279) + "]",
      "g"
    );
    var cleaned = value
      .replace(controlAndInvisible, "")
      .replace(/\s+/g, " ")
      .trim();
    return cleaned.slice(0, maxLen);
  }

  function cleanAmount(value) {
    var n = typeof value === "number" ? value : parseFloat(value);
    if (!isFinite(n) || n <= 0) return null;
    n = Math.round(n * 100) / 100; // snap to cents
    if (n > MAX_AMOUNT) return null;
    return n;
  }

  function isValidCategory(id) {
    return Object.prototype.hasOwnProperty.call(catById, id);
  }

  function cleanDate(value) {
    if (typeof value === "string" && DATE_RE.test(value)) {
      var d = new Date(value + "T00:00:00");
      if (!isNaN(d.getTime()) && d.getFullYear() >= MIN_YEAR && d.getFullYear() <= MAX_YEAR) {
        return value;
      }
    }
    return null;
  }

  // Validates/coerces a raw expense object (e.g. loaded from localStorage,
  // which a user or another script on the same origin can edit by hand).
  // Returns null for anything that can't be made into a safe record.
  function sanitizeExpense(raw) {
    if (!raw || typeof raw !== "object") return null;
    var amount = cleanAmount(raw.amount);
    var description = cleanText(raw.description, MAX_DESC_LEN);
    var date = cleanDate(raw.date);
    if (amount === null || !description || !date) return null;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : uid(),
      amount: amount,
      description: description,
      category: isValidCategory(raw.category) ? raw.category : "other",
      date: date,
      createdAt: typeof raw.createdAt === "number" && isFinite(raw.createdAt) ? raw.createdAt : Date.now()
    };
  }

  // ---------- state ----------
  var state = loadState();
  var viewMonth = new Date();
  viewMonth.setDate(1);
  var activeFilters = new Set(); // category ids; empty = all
  var editingId = null;
  var pendingUndo = null;
  var toastTimer = null;

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.expenses)) {
          var cleanExpenses = parsed.expenses.map(sanitizeExpense).filter(function (e) { return e !== null; });
          var cleanBudget = cleanAmount(parsed.budget);
          return { expenses: cleanExpenses, budget: cleanBudget || 0 };
        }
      }
    } catch (e) {}
    return { expenses: [], budget: 0 };
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function money(n) {
    var sign = n < 0 ? "-" : "";
    return sign + "GH₵" + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function todayISO() {
    var d = new Date();
    var tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0, 10);
  }

  function monthKey(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }

  // ---------- populate category select ----------
  var categoryInput = document.getElementById("categoryInput");
  CATEGORIES.forEach(function (c) {
    var opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = "● " + c.label;
    opt.className = "catopt-" + c.id;
    categoryInput.appendChild(opt);
  });

  // ---------- filter chips ----------
  var filterRow = document.getElementById("filterRow");
  function renderFilterChips() {
    filterRow.innerHTML = "";
    var allChip = document.createElement("button");
    allChip.type = "button";
    allChip.className = "chip" + (activeFilters.size === 0 ? " active" : "");
    allChip.textContent = "All";
    allChip.addEventListener("click", function () {
      activeFilters.clear();
      renderFilterChips();
      renderLedger();
    });
    filterRow.appendChild(allChip);

    CATEGORIES.forEach(function (c) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip" + (activeFilters.has(c.id) ? " active" : "");
      var dot = document.createElement("span");
      dot.className = "dot catdot-" + c.id;
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(c.label));
      chip.addEventListener("click", function () {
        if (activeFilters.has(c.id)) activeFilters.delete(c.id);
        else activeFilters.add(c.id);
        renderFilterChips();
        renderLedger();
      });
      filterRow.appendChild(chip);
    });

    var count = document.createElement("span");
    count.className = "filter-count";
    filterRow.appendChild(count);
  }

  // ---------- derived data ----------
  function expensesForMonth(d) {
    var key = monthKey(d);
    return state.expenses.filter(function (e) { return e.date.slice(0, 7) === key; });
  }

  function visibleExpenses() {
    var monthList = expensesForMonth(viewMonth).slice().sort(function (a, b) {
      return b.date.localeCompare(a.date) || b.createdAt - a.createdAt;
    });
    if (activeFilters.size === 0) return monthList;
    return monthList.filter(function (e) { return activeFilters.has(e.category); });
  }

  // ---------- rendering ----------
  var monthLabel = document.getElementById("monthLabel");
  var monthTotal = document.getElementById("monthTotal");
  var monthSub = document.getElementById("monthSub");
  var txnCount = document.getElementById("txnCount");
  var dailyAvg = document.getElementById("dailyAvg");
  var breakdownList = document.getElementById("breakdownList");
  var ledgerBody = document.getElementById("ledgerBody");
  var emptyState = document.getElementById("emptyState");

  var MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  function render() {
    monthLabel.textContent = MONTH_NAMES[viewMonth.getMonth()] + " " + viewMonth.getFullYear();

    var monthList = expensesForMonth(viewMonth);
    var total = monthList.reduce(function (s, e) { return s + e.amount; }, 0);
    monthTotal.textContent = money(total);

    var now = new Date();
    var isCurrentMonth = monthKey(now) === monthKey(viewMonth);
    var daysElapsed = isCurrentMonth ? now.getDate() : new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
    dailyAvg.textContent = daysElapsed ? money(total / daysElapsed) : money(0);
    txnCount.textContent = String(monthList.length);
    monthSub.textContent = monthList.length
      ? monthList.length + " transaction" + (monthList.length === 1 ? "" : "s") + " logged"
      : "no expenses logged yet";

    renderBudget(total);
    renderBreakdown(monthList, total);
    renderLedger();
  }

  // ---------- budget ----------
  var budgetDot = document.getElementById("budgetDot");
  var budgetAmt = document.getElementById("budgetAmt");
  var budgetLabel = document.getElementById("budgetLabel");
  var budgetFill = document.getElementById("budgetFill");

  function renderBudget(monthTotalAmount) {
    if (!state.budget) {
      budgetAmt.textContent = "Not set";
      budgetLabel.textContent = "";
      budgetDot.className = "status-dot good";
      budgetFill.className = "budget-bar-fill good";
      budgetFill.style.width = "0%";
      return;
    }
    var remaining = state.budget - monthTotalAmount;
    var pct = Math.min(100, (monthTotalAmount / state.budget) * 100);
    var status = "good";
    if (monthTotalAmount >= state.budget) status = "critical";
    else if (pct >= 80) status = "warning";

    budgetDot.className = "status-dot " + status;
    budgetFill.className = "budget-bar-fill " + status;
    budgetFill.style.width = pct.toFixed(1) + "%";

    if (remaining >= 0) {
      budgetAmt.textContent = money(remaining);
      budgetLabel.textContent = "left of " + money(state.budget);
    } else {
      budgetAmt.textContent = money(Math.abs(remaining));
      budgetLabel.textContent = "over " + money(state.budget) + " budget";
    }
  }

  // ---------- category breakdown ----------
  function renderBreakdown(monthList, total) {
    breakdownList.innerHTML = "";
    if (!monthList.length) {
      var empty = document.createElement("div");
      empty.className = "breakdown-empty";
      empty.textContent = "Nothing to show yet for this month.";
      breakdownList.appendChild(empty);
      return;
    }
    var sums = {};
    monthList.forEach(function (e) { sums[e.category] = (sums[e.category] || 0) + e.amount; });
    var ordered = CATEGORIES
      .map(function (c) { return { cat: c, amount: sums[c.id] || 0 }; })
      .filter(function (row) { return row.amount > 0; })
      .sort(function (a, b) { return b.amount - a.amount; });

    ordered.forEach(function (row) {
      var pct = total ? (row.amount / total) * 100 : 0;
      var wrap = document.createElement("div");
      wrap.className = "cat-row";

      var dot = document.createElement("span");
      dot.className = "dot catdot-" + row.cat.id;
      wrap.appendChild(dot);

      var name = document.createElement("span");
      name.className = "name";
      name.textContent = row.cat.label;
      wrap.appendChild(name);

      var amt = document.createElement("span");
      amt.className = "amt";
      amt.textContent = money(row.amount);
      wrap.appendChild(amt);

      var track = document.createElement("div");
      track.className = "cat-bar-track";
      var fill = document.createElement("div");
      fill.className = "cat-bar-fill catdot-" + row.cat.id;
      fill.style.width = pct.toFixed(1) + "%";
      track.appendChild(fill);
      wrap.appendChild(track);

      breakdownList.appendChild(wrap);
    });
  }

  // ---------- ledger table ----------
  function renderLedger() {
    var list = visibleExpenses();
    ledgerBody.innerHTML = "";

    if (!list.length) {
      emptyState.classList.remove("is-hidden");
      document.querySelector(".ledger-scroll").classList.add("is-hidden");
      return;
    }
    emptyState.classList.add("is-hidden");
    document.querySelector(".ledger-scroll").classList.remove("is-hidden");

    list.forEach(function (e) {
      var tr = document.createElement("tr");
      if (e.id === editingId) tr.className = "editing";

      var tdDate = document.createElement("td");
      tdDate.className = "date";
      var dparts = e.date.split("-");
      tdDate.textContent = dparts[1] + "/" + dparts[2];
      tr.appendChild(tdDate);

      var tdDesc = document.createElement("td");
      tdDesc.className = "desc";
      tdDesc.textContent = e.description;
      tr.appendChild(tdDesc);

      var tdCat = document.createElement("td");
      tdCat.className = "cat";
      var chip = document.createElement("span");
      chip.className = "cat-chip";
      var dot = document.createElement("span");
      dot.className = "dot catdot-" + catSlug(e.category);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(catById[e.category] ? catById[e.category].label : "Other"));
      tdCat.appendChild(chip);
      tr.appendChild(tdCat);

      var tdAmt = document.createElement("td");
      tdAmt.className = "amt";
      tdAmt.textContent = money(e.amount);
      tr.appendChild(tdAmt);

      var tdActions = document.createElement("td");
      tdActions.className = "actions";

      var editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "row-btn";
      editBtn.setAttribute("aria-label", "Edit expense");
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", function () { startEdit(e.id); });
      tdActions.appendChild(editBtn);

      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "row-btn danger";
      delBtn.setAttribute("aria-label", "Delete expense");
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", function () { deleteExpense(e.id); });
      tdActions.appendChild(delBtn);

      tr.appendChild(tdActions);
      ledgerBody.appendChild(tr);
    });
  }

  // ---------- form ----------
  var form = document.getElementById("expenseForm");
  var amountInput = document.getElementById("amountInput");
  var descInput = document.getElementById("descInput");
  var dateInput = document.getElementById("dateInput");
  var submitBtn = document.getElementById("submitBtn");
  var formTitle = document.getElementById("formTitle");
  var editFlag = document.getElementById("editFlag");
  var cancelEditBtn = document.getElementById("cancelEditBtn");

  dateInput.value = todayISO();

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var amount = cleanAmount(amountInput.value);
    if (amount === null) { amountInput.focus(); return; }
    var description = cleanText(descInput.value, MAX_DESC_LEN);
    if (!description) { descInput.focus(); return; }
    var category = isValidCategory(categoryInput.value) ? categoryInput.value : "other";
    var date = cleanDate(dateInput.value) || todayISO();

    if (editingId) {
      var existing = state.expenses.find(function (e) { return e.id === editingId; });
      if (existing) {
        existing.amount = amount;
        existing.description = description;
        existing.category = category;
        existing.date = date;
      }
      showToast("✓ Expense updated successfully");
      endEdit();
    } else {
      state.expenses.push({
        id: uid(),
        amount: amount,
        description: description,
        category: category,
        date: date,
        createdAt: Date.now()
      });
      showToast("✓ Expense added successfully");
      form.reset();
      dateInput.value = todayISO();
      amountInput.focus();
    }
    saveState();
    viewMonth = firstOfMonth(new Date(date + "T00:00:00"));
    render();
  });

  cancelEditBtn.addEventListener("click", endEdit);

  function firstOfMonth(d) {
    var n = new Date(d);
    n.setDate(1);
    return n;
  }

  function startEdit(id) {
    var e = state.expenses.find(function (x) { return x.id === id; });
    if (!e) return;
    editingId = id;
    amountInput.value = e.amount;
    descInput.value = e.description;
    categoryInput.value = e.category;
    dateInput.value = e.date;
    formTitle.textContent = "Edit expense";
    editFlag.classList.remove("is-hidden");
    submitBtn.textContent = "Save changes";
    cancelEditBtn.classList.remove("is-hidden");
    form.scrollIntoView({ behavior: "smooth", block: "center" });
    amountInput.focus();
    renderLedger();
  }

  function endEdit() {
    editingId = null;
    form.reset();
    dateInput.value = todayISO();
    formTitle.textContent = "Add an expense";
    editFlag.classList.add("is-hidden");
    submitBtn.textContent = "Add";
    cancelEditBtn.classList.add("is-hidden");
    renderLedger();
  }

  function deleteExpense(id) {
    var idx = state.expenses.findIndex(function (e) { return e.id === id; });
    if (idx === -1) return;
    var removed = state.expenses[idx];
    state.expenses.splice(idx, 1);
    if (editingId === id) endEdit();
    saveState();
    render();
    offerUndo(removed);
  }

  // ---------- month nav ----------
  document.getElementById("prevMonth").addEventListener("click", function () {
    viewMonth.setMonth(viewMonth.getMonth() - 1);
    render();
  });
  document.getElementById("nextMonth").addEventListener("click", function () {
    viewMonth.setMonth(viewMonth.getMonth() + 1);
    render();
  });
  document.getElementById("gotoToday").addEventListener("click", function () {
    viewMonth = firstOfMonth(new Date());
    render();
  });

  // ---------- budget editing ----------
  var editBudgetBtn = document.getElementById("editBudgetBtn");
  var budgetDisplay = document.getElementById("budgetDisplay");
  var budgetForm = document.getElementById("budgetForm");
  var budgetInput = document.getElementById("budgetInput");

  editBudgetBtn.addEventListener("click", function () {
    var showingForm = !budgetForm.classList.contains("is-hidden");
    if (showingForm) {
      budgetForm.classList.add("is-hidden");
      budgetDisplay.classList.remove("is-hidden");
      editBudgetBtn.textContent = "edit";
    } else {
      budgetInput.value = state.budget || "";
      budgetForm.classList.remove("is-hidden");
      budgetDisplay.classList.add("is-hidden");
      editBudgetBtn.textContent = "close";
      budgetInput.focus();
    }
  });

  budgetForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var val = cleanAmount(budgetInput.value);
    state.budget = val || 0;
    saveState();
    budgetForm.classList.add("is-hidden");
    budgetDisplay.classList.remove("is-hidden");
    editBudgetBtn.textContent = "edit";
    render();
  });

  // ---------- toast / undo ----------
  var toast = document.getElementById("toast");
  var toastMsg = document.getElementById("toastMsg");
  var toastUndo = document.getElementById("toastUndo");

  function showToast(msg) {
    toastUndo.classList.add("is-hidden");
    toastMsg.textContent = msg;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove("show"); }, 2600);
  }

  function offerUndo(removedExpense) {
    pendingUndo = removedExpense;
    toastMsg.textContent = "✓ Deleted “" + truncate(removedExpense.description, 28) + "”";
    toastUndo.classList.remove("is-hidden");
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.remove("show");
      pendingUndo = null;
    }, 5000);
  }

  toastUndo.addEventListener("click", function () {
    if (pendingUndo) {
      state.expenses.push(pendingUndo);
      saveState();
      pendingUndo = null;
      toast.classList.remove("show");
      render();
    }
  });

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  // ---------- CSV export ----------
  document.getElementById("exportBtn").addEventListener("click", function () {
    var rows = [["Date", "Description", "Category", "Amount"]];
    state.expenses
      .slice()
      .sort(function (a, b) { return a.date.localeCompare(b.date); })
      .forEach(function (e) {
        rows.push([e.date, e.description, catById[e.category] ? catById[e.category].label : "Other", e.amount.toFixed(2)]);
      });
    var csv = rows.map(function (r) {
      return r.map(function (cell) {
        var s = String(cell);
        // Neutralize CSV/formula injection: a leading =, +, -, @, tab, or CR
        // makes Excel/Sheets treat the cell as a formula when the file is
        // reopened there, so pad it with a leading apostrophe like a spreadsheet would.
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        s = s.replace(/"/g, '""');
        return /[",\n]/.test(s) ? '"' + s + '"' : s;
      }).join(",");
    }).join("\r\n");

    try {
      var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "my-wallet-" + todayISO() + ".csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (err) {
      showToast("Export isn't available in this preview — open the file directly in a browser.");
    }
  });

  // ---------- init ----------
  renderFilterChips();
  render();
})();
