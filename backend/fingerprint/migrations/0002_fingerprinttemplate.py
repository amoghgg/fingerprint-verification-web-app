from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('fingerprint', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='FingerprintTemplate',
            fields=[
                ('id',          models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name',        models.CharField(db_index=True, max_length=128, unique=True)),
                ('descriptor',  models.TextField()),
                ('image_hash',  models.CharField(blank=True, max_length=32)),
                ('enrolled_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at',  models.DateTimeField(auto_now=True)),
            ],
        ),
    ]
