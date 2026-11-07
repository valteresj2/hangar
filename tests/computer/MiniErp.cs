// A tiny "legacy ERP" for the computer workstation's real smoke test and demo: an invoice number, an amount, a
// password field and "Lançar", which asks "Confirma o lançamento?" (Sim/Não) and appends the entry to the file given
// as the first argument. Compiled on the fly with the in-box C# 5 compiler (no string interpolation).
using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

public class MiniErp : Form
{
    readonly string log;
    readonly TextBox invoice = new TextBox(), amount = new TextBox(), password = new TextBox();
    readonly Label status = new Label();

    public MiniErp(string logPath)
    {
        log = logPath;
        Text = "Mini ERP 1.0";
        ClientSize = new Size(460, 250);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 10f);
        AddRow("Fatura:", invoice, 20);
        AddRow("Valor:", amount, 60);
        password.UseSystemPasswordChar = true;
        AddRow("Senha:", password, 100);
        var post = new Button { Text = "Lançar", Left = 130, Top = 145, Width = 110, Height = 32 };
        post.Click += delegate { Post(); };
        var clear = new Button { Text = "Limpar", Left = 250, Top = 145, Width = 110, Height = 32 };
        clear.Click += delegate { invoice.Text = ""; amount.Text = ""; status.Text = "Campos limpos."; };
        status.SetBounds(20, 195, 420, 40);
        Controls.Add(post);
        Controls.Add(clear);
        Controls.Add(status);
        AcceptButton = null;
    }

    void AddRow(string label, TextBox box, int top)
    {
        var l = new Label { Text = label, Left = 20, Top = top + 3, Width = 100 };
        box.SetBounds(130, top, 300, 28);
        box.AccessibleName = label.TrimEnd(':');
        Controls.Add(l);
        Controls.Add(box);
    }

    void Post()
    {
        if (invoice.Text.Trim().Length == 0) { status.Text = "Informe a fatura."; return; }
        var answer = MessageBox.Show(this, "Confirma o lançamento da fatura " + invoice.Text + "?", "Confirmação",
            MessageBoxButtons.YesNo, MessageBoxIcon.Question);
        if (answer != DialogResult.Yes) { status.Text = "Lançamento cancelado."; return; }
        File.AppendAllText(log, DateTime.Now.ToString("s") + "\tfatura=" + invoice.Text + "\tvalor=" + amount.Text +
            "\tsenha_ok=" + (password.Text.Length > 0 ? "sim" : "não") + Environment.NewLine);
        status.Text = "Fatura " + invoice.Text + " lançada.";
        invoice.Text = "";
        amount.Text = "";
    }

    [STAThread]
    public static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.Run(new MiniErp(args.Length > 0 ? args[0] : Path.Combine(Path.GetTempPath(), "mini-erp.log")));
    }
}
